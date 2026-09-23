import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, readdir, readlink, chmod, mkdtemp } from 'node:fs/promises';
import { existsSync, accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { repository, quoteUnit as q, quoteExec as qe, stableRelease, verifyArchive, parseOptions, chooseDatabase, atomicJSON, activateRelease, pointCurrent, readConfig } from './install-lib.mjs';

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const output = (command, args) => run(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
const succeeds = (command, args) => spawnSync(command, args, { stdio: 'ignore' }).status === 0;
const ctl = (...args) => run('systemctl', ['--user', ...args]);
const which = name => {
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const executable = path.resolve(directory, name);
    try { accessSync(executable, constants.X_OK); return executable; } catch {}
  }
  return '';
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const units = path.join(os.homedir(), '.config/systemd/user');
const root = path.resolve(process.env.GARNET_HOME || path.join(os.homedir(), '.local/share/garnet'));

async function probe(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2500 });
  try {
    await client.connect();
    const info = await client.db().command({ buildInfo: 1 });
    if (Number(info.version.split('.')[0]) < 8) throw Error('MongoDB 8 or newer is required.');
    // Verify application-level database access, not just an unauthenticated ping.
    await client.db().listCollections({}, { nameOnly: true }).toArray();
  } catch { throw Error('Cannot access a compatible MongoDB database. Check its address, version and credentials.'); }
  finally { await client.close(); }
}
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(Error(`Port ${port} is already occupied. Nothing using that port was stopped.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function healthy() {
  for (let i = 0; i < 90; i++) {
    const active = succeeds('systemctl', ['--user', 'is-active', '--quiet', 'garnet.service']);
    if (active && await fetch('http://127.0.0.1:7777/api/health', { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false)) return;
    await pause(1000);
  }
  throw Error('App did not become healthy. Run garnet logs.');
}
async function installPodman() {
  if (!which('sudo')) throw Error('sudo is required to install a container runtime.');
  if (which('apt-get')) { run('sudo', ['apt-get', 'update']); run('sudo', ['apt-get', 'install', '-y', 'podman', 'uidmap', 'slirp4netns', 'fuse-overlayfs']); }
  else if (which('dnf')) run('sudo', ['dnf', 'install', '-y', 'podman', 'shadow-utils', 'slirp4netns', 'fuse-overlayfs']);
  else if (which('pacman')) run('sudo', ['pacman', '-S', '--needed', '--noconfirm', 'podman', 'shadow', 'slirp4netns', 'fuse-overlayfs']);
  else if (which('zypper')) run('sudo', ['zypper', '--non-interactive', 'install', 'podman', 'shadow', 'slirp4netns', 'fuse-overlayfs']);
  else throw Error('Install Podman or Docker using your distribution package manager, then rerun the installer.');
  const user = os.userInfo().username;
  for (const [file, flag] of [['/etc/subuid', '--add-subuids'], ['/etc/subgid', '--add-subgids']]) {
    const rows = (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => line.split(':'));
    if (!rows.some(([name]) => name === user || name === String(process.getuid()))) {
      const start = Math.max(100000, ...rows.map(([, start, count]) => Number(start) + Number(count)));
      run('sudo', ['usermod', flag, `${start}-${start + 65535}`, user]);
    }
  }
  if (!succeeds('podman', ['info'])) throw Error('Podman rootless setup failed. Check user namespaces and subordinate UID/GID support.');
  return which('podman');
}
async function containerDatabase(database) {
  if (database.engine) return database; // Existing installation: do not recreate or replace storage.
  await freePort(27018);
  if (process.arch === 'x64' && !/\bavx\b/.test(await readFile('/proc/cpuinfo', 'utf8'))) throw Error('MongoDB 8 requires an x86-64 CPU with AVX. Use --mongo-uri to connect to a compatible server.');
  const engine = succeeds('podman', ['info']) ? which('podman') : succeeds('docker', ['info']) ? which('docker') : await installPodman();
  const name = 'garnet-mongo';
  if (succeeds(engine, ['container', 'inspect', name])) throw Error('A garnet-mongo container already exists without installation metadata. Preserve it and explicitly configure --mongo-uri.');
  if (succeeds(engine, ['volume', 'inspect', name])) throw Error('A garnet-mongo volume already exists. Restore its installation configuration instead of creating a new database.');
  const image = 'docker.io/library/mongo:8.0';
  run(engine, ['pull', image]);
  const details = JSON.parse(output(engine, ['image', 'inspect', image]))[0];
  const digest = details.RepoDigests?.[0];
  if (!digest || !/@sha256:[a-f0-9]{64}$/.test(digest)) throw Error('Cannot resolve a pinned MongoDB image digest.');
  if (path.basename(engine) === 'docker' && !succeeds('systemctl', ['is-enabled', '--quiet', 'docker.service']) && !succeeds('systemctl', ['--user', 'is-enabled', '--quiet', 'docker.service'])) {
    run('sudo', ['systemctl', 'enable', '--now', 'docker.service']);
  }
  run(engine, ['volume', 'create', '--label', 'app=garnet', name]);
  try { run(engine, ['create', '--name', name, '--label', 'app=garnet', '--publish', '127.0.0.1:27018:27017', '--volume', `${name}:/data/db`, digest, '--bind_ip_all']); }
  catch (error) { run(engine, ['volume', 'rm', name]); throw error; } // Newly created, never started: no user data exists yet.
  return { ...database, engine, container: name, volume: name, image: digest };
}
function service(description, command, { extra = '', working, restart = 'on-failure', tail = '' } = {}) {
  return `[Unit]\nDescription=${description}\nAfter=network.target\nStartLimitIntervalSec=0\n${extra}\n[Service]\nType=simple\n${working ? `WorkingDirectory=${working.replaceAll('%', '%%')}\n` : ''}ExecStart=${command.map(qe).join(' ')}\nRestart=${restart}\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=60\n${tail}\n[Install]\nWantedBy=default.target\n`;
}
async function legacyInstall() {
  let working;
  try { working = output('systemctl', ['--user', 'show', 'garnet.service', '--property=WorkingDirectory', '--value']); } catch { return null; }
  if (!working) return null;
  // Only automatically adopt the known native installer shape.
  const command = output('systemctl', ['--user', 'show', 'garnet.service', '--property=ExecStart', '--value']);
  if (!command.includes(path.join(working, 'build/server.mjs')) || /\s--[a-z]/.test(command)) {
    throw Error('Existing custom Garnet service detected. Follow docs/host-migration.md before replacing its configuration.');
  }
  if (!existsSync(path.join(working, 'data/mongo-host'))) throw Error('Existing Garnet service has unfamiliar storage. Preserve it and migrate explicitly.');
  return { data: path.join(working, 'data'), dataParent: working, database: { kind: 'host', uri: 'mongodb://127.0.0.1:27018/ed', service: 'garnet-mongo.service' } };
}
async function writeServices(base, config) {
  await mkdir(units, { recursive: true });
  const database = config.database;
  if (database.kind === 'container') {
    await writeFile(path.join(units, 'garnet-mongo.service'), service('Notes database', [database.engine, 'start', '--attach', database.container], {
      tail: `ExecStop=${[database.engine, 'stop', '--time', '45', database.container].map(qe).join(' ')}\n`,
    }));
  }
  const ownsDatabase = database.kind === 'container' || database.service;
  await writeFile(path.join(units, 'garnet.service'), service('Notes and agents', [config.node, path.join(base, 'current/scripts/service.mjs'), path.join(base, 'install.json')], {
    working: config.dataParent,
    extra: ownsDatabase ? 'Wants=garnet-mongo.service\nAfter=garnet-mongo.service' : '',
  }));
  const updateCommand = [which('flock'), '-n', '-E', '75', path.join(base, 'install.lock'), config.node, path.join(base, 'current/scripts/manage.mjs'), 'update-locked', `--root=${base}`];
  await writeFile(path.join(units, 'garnet-update.service'), `[Unit]\nDescription=Update notes from stable releases\n\n[Service]\nType=oneshot\nExecStart=${updateCommand.map(qe).join(' ')}\nEnvironment=${q(`PATH=${config.path}`)}\nTimeoutStartSec=30min\nSuccessExitStatus=75\n`);
  await writeFile(path.join(units, 'garnet-update.timer'), '[Unit]\nDescription=Daily notes updates\n\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n');
  if (config.caddy) await writeFile(path.join(units, 'garnet-https.service'), service('Notes private HTTPS', [config.caddy, 'run', '--config', path.join(config.data, 'runtime/Caddyfile'), '--adapter', 'caddyfile', '--watch'], {
    working: config.dataParent, extra: 'Wants=garnet.service\nAfter=garnet.service\nPartOf=garnet.service',
  }));
  ctl('daemon-reload');
  if (ownsDatabase) ctl('enable', '--now', 'garnet-mongo.service');
}
async function snapshotServices() {
  const names = ['garnet.service', 'garnet-https.service', 'garnet-update.service', 'garnet-update.timer'];
  const snapshots = await Promise.all(names.map(async name => ({ name,
    content: await readFile(path.join(units, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
    active: succeeds('systemctl', ['--user', 'is-active', '--quiet', name]),
    enabled: succeeds('systemctl', ['--user', 'is-enabled', '--quiet', name]),
  })));
  return async () => {
    // Stop new units first, then restore definitions before restarting the original app.
    for (const { name, content } of snapshots) if (!content) succeeds('systemctl', ['--user', 'disable', '--now', name]);
    for (const { name, content } of snapshots) {
      if (content) await writeFile(path.join(units, name), content);
      else await rm(path.join(units, name), { force: true });
    }
    ctl('daemon-reload');
    for (const { name, content, active, enabled } of snapshots) if (content) {
      ctl(enabled ? 'enable' : 'disable', name);
      if (name !== 'garnet-update.service') ctl(active ? 'restart' : 'stop', name);
    }
  };
}
async function install(base, options) {
  if (process.platform !== 'linux' || process.getuid() === 0) throw Error('Install as a regular Linux user.');
  if (!succeeds('systemctl', ['--user', 'show-environment'])) throw Error('A working systemd user session is required.');
  const stage = path.resolve(options.stage || '');
  if (!stage.startsWith(`${base}/releases/.stage.`)) throw Error('Expected a staged release inside the installation directory.');
  const version = stableRelease({ tag_name: (await readFile(path.join(stage, 'VERSION'), 'utf8')).trim() });
  let config;
  try { config = await readConfig(base); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const previousConfig = config;
  const old = config ? null : await legacyInstall();
  if (!config && !old) await freePort(7777);
  const data = config?.data || old?.data || path.join(base, 'data');
  for (const name of ['documents', 'runtime', 'caddy-host']) await mkdir(path.join(data, name), { recursive: true });
  let database = await chooseDatabase({ existing: config?.database, legacy: old?.database, mode: options.database, uri: options['mongo-uri'], probe });
  // Configure lingering before claiming unattended boot support.
  const user = os.userInfo().username;
  if (!succeeds('loginctl', ['enable-linger', user])) run('sudo', ['loginctl', 'enable-linger', user]);
  if (output('loginctl', ['show-user', user, '--property=Linger', '--value']) !== 'yes') throw Error('Could not enable user services at boot.');
  if (database.kind === 'container') database = await containerDatabase(database);
  config = { ...config, version: 1, node: process.execPath, path: process.env.PATH, data, dataParent: config?.dataParent || old?.dataParent || base, database,
    caddy: config?.caddy || which('caddy') || (existsSync(path.join(os.homedir(), '.local/lib/garnet/caddy')) ? path.join(os.homedir(), '.local/lib/garnet/caddy') : ''), autoUpdate: config?.autoUpdate ?? true };
  await atomicJSON(path.join(base, 'install.json'), config);
  const restoreServices = await snapshotServices();
  const previousRelease = await readlink(path.join(base, 'current')).catch(() => null);
  try {
    await writeServices(base, config);
    let databaseReady = false;
    for (let i = 0; i < 30; i++) { try { await probe(database.uri); databaseReady = true; break; } catch { await pause(1000); } }
    if (!databaseReady) throw Error('Database did not become ready. Inspect its service logs; the selected database has been preserved.');
    const target = path.join(base, 'releases', `${version}-${Date.now()}`);
    await rename(stage, target);
    await activateRelease(base, target, { restart: () => ctl('restart', 'garnet.service'), healthy });
    ctl('enable', 'garnet.service');
    if (config.caddy) ctl('enable', '--now', 'garnet-https.service');
    ctl(config.autoUpdate ? 'enable' : 'disable', '--now', 'garnet-update.timer');
  } catch (error) {
    if (previousConfig) await atomicJSON(path.join(base, 'install.json'), previousConfig);
    if (previousRelease) await pointCurrent(base, previousRelease);
    else await rm(path.join(base, 'current'), { force: true });
    try { await restoreServices(); }
    catch { throw Error(`${error.message} Service restoration also failed; inspect systemctl --user status garnet.service.`); }
    throw error;
  }
  const launcher = path.join(os.homedir(), '.local/bin/garnet');
  await mkdir(path.dirname(launcher), { recursive: true });
  // JSON strings are safe inside JavaScript, not shell. The shell wrapper uses single-quote escaping.
  const sh = text => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(launcher, `#!/bin/sh\nexec ${sh(config.node)} ${sh(path.join(base, 'current/scripts/manage.mjs'))} "$@" --root=${sh(base)}\n`, { mode: 0o755 });
  await chmod(launcher, 0o755);
  console.log(`Installed ${version}. Open http://localhost:7777\nFirst login: admin / password; change the password when prompted.\nStarts at boot. Daily updates: ${config.autoUpdate ? 'on' : 'off'}.\nCommands: ${launcher} status | logs | update`);
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'Garnet-updater' } });
  if (!response.ok) throw Error(`Release download failed (${response.status}). Current app is unchanged.`);
  return Buffer.from(await response.arrayBuffer());
}
async function update(base) {
  const config = await readConfig(base);
  process.env.PATH = config.path;
  const release = JSON.parse((await download(`https://api.github.com/repos/${repository}/releases/latest`)).toString());
  const version = stableRelease(release);
  const current = await readlink(path.join(base, 'current'));
  const currentVersion = (await readFile(path.join(current, 'VERSION'), 'utf8')).trim();
  if (version === currentVersion) { console.log(`Already running ${version}.`); return; }
  const numbers = v => v.slice(1).split('.').map(Number);
  const a = numbers(version), b = numbers(currentVersion);
  const difference = a.map((n, i) => n - b[i]).find(n => n !== 0);
  if (difference < 0) { console.log('Latest published release is older; skipping downgrade.'); return; }
  const asset = name => {
    const url = release.assets.find(a => a.name === name)?.browser_download_url;
    if (!url?.startsWith(`https://github.com/${repository}/releases/download/`)) throw Error(`Missing release asset: ${name}`);
    return url;
  };
  const bytes = await download(asset('garnet-linux.tar.gz'));
  verifyArchive(bytes, (await download(asset('SHA256SUMS'))).toString());
  const temporary = await mkdtemp(path.join(base, 'releases/.stage.'));
  const archive = path.join(temporary, 'release.tar.gz');
  let target;
  try {
    await writeFile(archive, bytes);
    const names = output('tar', ['-tzf', archive]).split('\n');
    if (names.some(name => name.startsWith('/') || name.split('/').includes('..'))) throw Error('Unsafe archive path.');
    run('tar', ['-xzf', archive, '--no-same-owner', '-C', temporary]);
    await rm(archive);
    await writeFile(path.join(temporary, 'VERSION'), `${version}\n`);
    run(path.join(path.dirname(config.node), 'npm'), ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary });
    run(config.node, ['--check', path.join(temporary, 'build/server.mjs')]);
    target = path.join(base, 'releases', `${version}-${Date.now()}`);
    await rename(temporary, target);
    const previous = await activateRelease(base, target, { restart: () => ctl('restart', 'garnet.service'), healthy });
    if (config.caddy) ctl('restart', 'garnet-https.service');
    for (const name of await readdir(path.join(base, 'releases'))) {
      const entry = path.join(base, 'releases', name);
      if (entry !== target && entry !== previous && /^v\d+\.\d+\.\d+-\d+$/.test(name)) await rm(entry, { recursive: true, force: true });
    }
    console.log(`Updated to ${version}. Previous release retained for recovery.`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const positional = args.filter(arg => !arg.startsWith('--'));
  const options = parseOptions(args.filter(arg => arg.startsWith('--')));
  const base = path.resolve(options.root || root);
  if (command === 'install') return install(base, options);
  if (command === 'update-locked') return update(base);
  if (command === 'update') {
    const config = await readConfig(base);
    return run('flock', ['-n', '-E', '75', path.join(base, 'install.lock'), config.node, fileURLToPath(import.meta.url), 'update-locked', `--root=${base}`]);
  }
  if (command === 'logs') return run('journalctl', ['--user', '-u', 'garnet.service', '-n', '80', '-f']);
  if (command === 'status') { ctl('status', 'garnet.service', '--no-pager'); return ctl('list-timers', 'garnet-update.timer', '--no-pager'); }
  if (command === 'start' || command === 'stop') {
    const config = await readConfig(base);
    if (command === 'stop' && config.caddy) ctl('stop', 'garnet-https.service');
    ctl(command, 'garnet.service');
    if (command === 'start' && config.caddy) ctl('start', 'garnet-https.service');
    return;
  }
  if (command === 'autoupdate') {
    const action = positional[0] || 'status';
    if (action === 'status') return ctl('status', 'garnet-update.timer', '--no-pager');
    if (!['on', 'off'].includes(action)) throw Error('Usage: garnet autoupdate on|off|status');
    const config = await readConfig(base);
    ctl(action === 'on' ? 'enable' : 'disable', '--now', 'garnet-update.timer');
    config.autoUpdate = action === 'on'; await atomicJSON(path.join(base, 'install.json'), config); return;
  }
  console.log('Usage: garnet {start|stop|status|logs|update|autoupdate on|off|status}');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
