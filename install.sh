#!/usr/bin/env bash
# Public bootstrap. Application and database processes always run as your user.
set -Eeuo pipefail
umask 077
die() { printf 'Install failed: %s\n' "$*" >&2; exit 1; }
[[ ${1:-} != --help ]] || { echo 'Usage: install.sh [--database=auto|host|container] [--mongo-uri=URI] [--port=7777]'; exit 0; }
[[ $(uname -s) == Linux && -d /run/systemd/system ]] || die 'Linux with systemd is required.'
[[ $EUID != 0 ]] || die 'Run this command as your regular account, without sudo. It requests sudo when needed.'
command -v curl >/dev/null || die 'Install curl first.'
systemctl --user show-environment >/dev/null || die 'Run from a login session with a working systemd user manager.'
case $(uname -m) in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) die 'Supported architectures: x86-64 and ARM64.' ;; esac
base=${GARNET_HOME:-"$HOME/.local/share/garnet"}
mkdir -p "$base/releases"
scratch=$(mktemp -d "$base/.bootstrap.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  https://api.github.com/repos/keysforthewin/Garnet/releases/latest -o "$scratch/release.json" \
  || die 'Cannot fetch a published release. Check your connection; a stable GitHub release must exist.'

if ! command -v tar >/dev/null || ! command -v xz >/dev/null || ! command -v flock >/dev/null; then
  command -v sudo >/dev/null || die 'sudo is needed to install tar, xz and util-linux.'
  if command -v apt-get >/dev/null; then sudo apt-get update; sudo apt-get install -y ca-certificates tar xz-utils util-linux
  elif command -v dnf >/dev/null; then sudo dnf install -y ca-certificates tar xz util-linux
  elif command -v pacman >/dev/null; then sudo pacman -S --needed --noconfirm ca-certificates tar xz util-linux
  elif command -v zypper >/dev/null; then sudo zypper --non-interactive install ca-certificates tar xz util-linux
  else die 'Install tar, xz and util-linux using your distribution package manager.'; fi
fi
exec 9>"$base/install.lock"
flock -n 9 || die 'Another install or update is running.'

node_bin=$(command -v node || true)
# Reuse a private runtime left by an earlier attempt.
if [[ -z $node_bin ]]; then
  for candidate in "$base"/runtime/node-v24.*-linux-"$arch"/bin/node; do
    if [[ -x $candidate ]] && "$candidate" --version >/dev/null 2>&1; then node_bin=$candidate; break; fi
  done
fi
if [[ -n $node_bin ]]; then export PATH="$(dirname "$node_bin"):$PATH"; fi
if [[ -z $node_bin ]] || ! "$node_bin" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===22&&b>=12)||a===24?0:1)' || ! command -v npm >/dev/null; then
  # Private runtime: never replace the user's system Node installation.
  command -v sha256sum >/dev/null || die 'sha256sum (coreutils) is required.'
  curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$scratch/node-checksums"
  archive=$(awk -v arch="$arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$scratch/node-checksums")
  [[ -n $archive && $archive != *$'\n'* ]] || die 'Unable to find a Node 24 LTS build for this architecture.'
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v24.x/$archive" -o "$scratch/$archive"
  (cd "$scratch"; awk -v file="$archive" '$2==file' node-checksums | sha256sum --check --status) || die 'Node checksum mismatch.'
  runtime="$base/runtime/${archive%.tar.xz}"
  mkdir -p "$runtime"
  tar -xJf "$scratch/$archive" --strip-components=1 -C "$runtime"
  node_bin="$runtime/bin/node"
fi
export PATH="$(dirname "$node_bin"):$PATH"
"$node_bin" --version >/dev/null || die 'The Node runtime is incompatible with this Linux installation.'
# Read from the terminal: stdin contains this script when invoked with curl | bash.
default_port=7777
if [[ -f "$base/install.json" ]]; then
  default_port=$("$node_bin" -e 'const c=require(process.argv[1]); console.log(c.port || 7777)' "$base/install.json")
fi
port_given=false
for arg in "$@"; do [[ $arg != --port=* ]] || port_given=true; done
if [[ $port_given == false ]] && { exec 8<>/dev/tty; } 2>/dev/null; then
  printf '\nGarnet opens in your web browser at http://127.0.0.1:%s\n' "$default_port" >&8
  printf 'The number at the end is called the port. You can change it if you like.\n' >&8
  printf "If you don't understand this, just press Enter.\n\n" >&8
  while true; do
    printf 'Port [%s]: ' "$default_port" >&8
    IFS= read -r chosen_port <&8 || die 'Port selection cancelled.'
    chosen_port=${chosen_port:-$default_port}
    if [[ $chosen_port =~ ^[0-9]{4,5}$ ]] && (( 10#$chosen_port >= 1024 && 10#$chosen_port <= 65535 )); then
      set -- "$@" "--port=$chosen_port"
      break
    fi
    printf 'Please type a number from 1024 to 65535, or just press Enter.\n' >&8
  done
  exec 8>&-
fi
# Stage a release without executing remote shell fragments or requiring git/build tools.
"$node_bin" --input-type=module - "$scratch/release.json" "$scratch" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
const [file, dir] = process.argv.slice(2);
const release = JSON.parse(await readFile(file, 'utf8'));
if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw Error('Expected a stable versioned release.');
for (const name of ['garnet-linux.tar.gz', 'SHA256SUMS']) {
  const asset = release.assets.find(a => a.name === name);
  if (!asset?.browser_download_url?.startsWith('https://github.com/keysforthewin/Garnet/releases/download/')) throw Error(`Missing release asset: ${name}`);
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw Error(`Download failed: ${name} (${response.status})`);
  await writeFile(`${dir}/${name}`, Buffer.from(await response.arrayBuffer()));
}
const { createHash } = await import('node:crypto');
const sums = await readFile(`${dir}/SHA256SUMS`, 'utf8');
const hash = createHash('sha256').update(await readFile(`${dir}/garnet-linux.tar.gz`)).digest('hex');
if (!sums.split('\n').some(line => line.trim() === `${hash}  garnet-linux.tar.gz`)) throw Error('Release checksum mismatch.');
await writeFile(`${dir}/version`, release.tag_name);
NODE
stage=$(mktemp -d "$base/releases/.stage.XXXXXX")
trap 'rm -rf "$scratch" "${stage:-}"' EXIT
tar -tzf "$scratch/garnet-linux.tar.gz" | while IFS= read -r entry; do
  [[ $entry != /* && /$entry/ != */../* ]] || die 'Unsafe archive path.'
done
tar -xzf "$scratch/garnet-linux.tar.gz" --no-same-owner -C "$stage"
printf '%s\n' "$(cat "$scratch/version")" > "$stage/VERSION"
(cd "$stage"; npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
"$node_bin" "$stage/scripts/manage.mjs" install --root="$base" --stage="$stage" "$@"
