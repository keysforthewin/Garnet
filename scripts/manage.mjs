import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm, readdir, readlink, chmod, mkdtemp } from 'node:fs/promises';
import { existsSync, accessSync, constants, realpathSync } from 'node:fs';
import { availablePort, appPort, validPort } from './ports.mjs';
import { retireHttps } from './retire-https.mjs';
import os from 'node:os';
import { setupPath } from './shell-path.mjs';
import { launchMcp } from './mcp-launch.mjs';
import { uninstall } from './uninstall.mjs';
import { createInterface } from 'node:readline/promises';
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
async function healthy(config, base) {
  for (let i = 0; i < 90; i++) {
    const active = succeeds('systemctl', ['--user', 'is-active', '--quiet', 'garnet.service']);
    const listener = JSON.parse(await readFile(path.join(config.data, 'runtime/listen.json'), 'utf8').catch(() => 'null'));
    const pid = Number(output('systemctl', ['--user', 'show', 'garnet.service', '--property=MainPID', '--value']));
    // Older releases did not write listen.json; retain rollback compatibility.
    const oldRelease = base && !existsSync(path.join(base, 'current/scripts/ports.mjs'));
    const port = listener?.pid === pid ? validPort(listener.port) : oldRelease ? 7777 : null;
    if (active && pid > 0 && port && await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(r => r.ok).catch(() => false)) return;
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
async function containerDatabase(database, httpPort, base) {
  const checkpoint = path.join(base, 'database-setup.json');
  const inspect = (engine, kind, name) => {
    try { return JSON.parse(output(engine, [kind, 'inspect', name]))[0]; }
    catch (error) { if (/no such|not found|does not exist/i.test(String(error.stderr))) return null; throw error; }
  };
  if (!database.engine) {
    const port = await availablePort(27018, [httpPort]);
    if (process.arch === 'x64' && !/\bavx\b/.test(await readFile('/proc/cpuinfo', 'utf8'))) throw Error('MongoDB 8 requires an x86-64 CPU with AVX. Use --mongo-uri to connect to a compatible server.');
    const engine = succeeds('podman', ['info']) ? which('podman') : succeeds('docker', ['info']) ? which('docker') : await installPodman();
    const name = 'garnet-mongo';
    if (succeeds(engine, ['container', 'inspect', name]) || succeeds(engine, ['volume', 'inspect', name])) throw Error('Existing garnet-mongo storage has no installation metadata. Preserve it and explicitly configure --mongo-uri.');
    const image = 'docker.io/library/mongo:8.0';
    const imageOwned = !succeeds(engine, ['image', 'inspect', image]);
    database = { ...database, uri: `mongodb://127.0.0.1:${port}/ed`, port, engine, container: name, volume: name, image, imageOwned };
    // Save ownership before creating resources, so an interrupted install can resume.
    await atomicJSON(checkpoint, database);
  }
  const { engine, container, volume } = database;
  let info = inspect(engine, 'container', container);
  const storage = inspect(engine, 'volume', volume);
  if (info && (info.Config.Labels?.app !== 'garnet' || !info.Mounts?.some(m => m.Name === volume && m.Destination === '/data/db'))) throw Error('Unrecognized database container. Its storage was preserved.');
  if (storage && storage.Labels?.app !== 'garnet') throw Error('Unrecognized database volume. Its storage was preserved.');
  if (info?.State.Running) return database;
  if (path.basename(engine) === 'docker' && !succeeds('systemctl', ['is-enabled', '--quiet', 'docker.service']) && !succeeds('systemctl', ['--user', 'is-enabled', '--quiet', 'docker.service'])) run('sudo', ['systemctl', 'enable', '--now', 'docker.service']);
  if (!succeeds(engine, ['image', 'inspect', database.image])) run(engine, ['pull', database.image]);
  const details = JSON.parse(output(engine, ['image', 'inspect', database.image]))[0];
  const digest = details.RepoDigests?.[0];
  if (!digest || !/@sha256:[a-f0-9]{64}$/.test(digest)) throw Error('Cannot resolve a pinned MongoDB image digest.');
  const port = await availablePort(database.port || Number(new URL(database.uri).port), [httpPort]);
  const previousPort = Number(info?.NetworkSettings?.Ports?.['27017/tcp']?.[0]?.HostPort || new URL(database.uri).port);
  database = { ...database, port, uri: `mongodb://127.0.0.1:${port}/ed`, image: digest };
  await atomicJSON(checkpoint, database);
  if (!storage) run(engine, ['volume', 'create', '--label', 'app=garnet', volume]);
  if (info && port !== previousPort) { run(engine, ['rm', '--volumes', container]); info = null; }
  if (!info) run(engine, ['create', '--name', container, '--label', 'app=garnet', '--publish', `127.0.0.1:${port}:27017`, '--volume', `${volume}:/data/db`, digest, '--bind_ip_all']);
  return database;
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
  const sourceConfig = JSON.parse(await readFile(path.join(working, 'data/runtime/source-install.json'), 'utf8').catch(() => '{}'));
  const knownSource = command.includes(path.join(working, 'scripts/source-service.mjs')) && sourceConfig.mongoPort;
  if (!knownSource && (!command.includes(path.join(working, 'build/server.mjs')) || /\s--[a-z]/.test(command))) {
    throw Error('Existing custom Garnet service detected. Follow docs/host-migration.md before replacing its configuration.');
  }
  if (!existsSync(path.join(working, 'data/mongo-host'))) throw Error('Existing Garnet service has unfamiliar storage. Preserve it and migrate explicitly.');
  return { data: path.join(working, 'data'), dataParent: working, port: await appPort({ data: path.join(working, 'data'), port: sourceConfig.port }), database: { kind: 'host', uri: `mongodb://127.0.0.1:${sourceConfig.mongoPort || 27018}/ed`, service: 'garnet-mongo.service' } };
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
  ctl('daemon-reload');
  if (ownsDatabase) ctl('enable', '--now', 'garnet-mongo.service');
}
async function snapshotServices() {
  const names = ['garnet.service', 'garnet-update.service', 'garnet-update.timer'];
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
  const port = options.port || (config ? await appPort(config) : old?.port) || await availablePort(7777);
  const selectedPort = !config && !old && options.port ? await availablePort(port) : port;
  const data = config?.data || old?.data || path.join(base, 'data');
  for (const name of ['documents', 'runtime']) await mkdir(path.join(data, name), { recursive: true });
  let database = await chooseDatabase({ existing: JSON.parse(await readFile(path.join(base, 'database-setup.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; })) || config?.database, legacy: old?.database, mode: options.database, uri: options['mongo-uri'], probe });
  // Configure lingering before claiming unattended boot support.
  const user = os.userInfo().username;
  if (!succeeds('loginctl', ['enable-linger', user])) run('sudo', ['loginctl', 'enable-linger', user]);
  if (output('loginctl', ['show-user', user, '--property=Linger', '--value']) !== 'yes') throw Error('Could not enable user services at boot.');
  if (database.kind === 'container') database = await containerDatabase(database, selectedPort, base);
  config = { ...config, version: 1, port: selectedPort, node: process.execPath, path: process.env.PATH, data, dataParent: config?.dataParent || old?.dataParent || base, database,
    autoUpdate: config?.autoUpdate ?? true };
  delete config.caddy;
  await retireHttps();
  if (options.port) await rm(path.join(data, 'runtime/listen.json'), { force: true });
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
    await activateRelease(base, target, { restart: () => ctl('restart', 'garnet.service'), healthy: () => healthy(config, base) });
    ctl('enable', 'garnet.service');
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
  await rm(path.join(base, 'database-setup.json'), { force: true });
  const shellPath = await setupPath();
  if (shellPath.changed) console.log(`Added ~/.local/bin to PATH in ${shellPath.file}.`);
  if (!shellPath.active) console.log(`Open a new terminal, or run: ${shellPath.shell === 'fish' ? 'fish_add_path --path "$HOME/.local/bin"' : 'export PATH="$HOME/.local/bin:$PATH"'}`);
  await connectAgents(base, config.node);
  console.log(`Installed ${version}. Open http://127.0.0.1:${await appPort(config)}\nMongoDB: ${new URL(config.database.uri).host}\nFirst login: admin / password; change the password when prompted.\nStarts at boot. Daily updates: ${config.autoUpdate ? 'on' : 'off'}.\nCommands: garnet url | status | logs | update | uninstall`);
}
async function connectAgents(base, node) {
  try {
    const pkg = JSON.parse(await readFile(path.join(base, 'current/packages/garnet-mcp/package.json'), 'utf8'));
    run('npm', ['exec', '--yes', `--package=garnet-mcp@${pkg.version}`, '--', 'garnet-mcp', 'setup', `--root=${base}`], { env: { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH || ''}` } });
  } catch (error) { console.error(`Garnet is installed; agent setup needs attention: ${error.message}\nRetry: npx garnet-mcp setup --root=${base}`); }
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'Garnet-updater' } });
  if (!response.ok) throw Error(`Release download failed (${response.status}). Current app is unchanged.`);
  return Buffer.from(await response.arrayBuffer());
}
async function update(base) {
  const config = await readConfig(base);
  process.env.PATH = config.path;
  await retireHttps();
  if ('caddy' in config) { delete config.caddy; await atomicJSON(path.join(base, 'install.json'), config); }
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
    const previous = await activateRelease(base, target, { restart: () => ctl('restart', 'garnet.service'), healthy: () => healthy(config, base) });
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
  if (command === 'mcp') return launchMcp(base);
  if (command === 'uninstall') {
    if (!options.yes) {
      if (!process.stdin.isTTY) throw Error('Uninstall deletes Garnet and its managed notes database. Run garnet uninstall --yes to confirm.');
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      let answer;
      try { answer = await prompt.question('Delete Garnet and all notes in its managed database? [y/N] '); } finally { prompt.close(); }
      if (!/^y(es)?$/i.test(answer.trim())) { console.log('Uninstall cancelled.'); return; }
    }
    const config = await readConfig(base);
    if (existsSync(path.join(units, 'garnet-update.timer'))) ctl('disable', '--now', 'garnet-update.timer');
    if (existsSync(path.join(units, 'garnet-update.service'))) ctl('stop', 'garnet-update.service');
    return run('flock', ['-n', '-E', '75', path.join(base, 'install.lock'), config.node, fileURLToPath(import.meta.url), 'uninstall-locked', `--root=${base}`]);
  }
  if (command === 'uninstall-locked') return uninstall(base);
  if (command === 'install') return install(base, options);
  if (command === 'update-locked') return update(base);
  if (command === 'update') {
    const config = await readConfig(base);
    run('flock', ['-n', '-E', '75', path.join(base, 'install.lock'), config.node, fileURLToPath(import.meta.url), 'update-locked', `--root=${base}`]);
    // Run outside the update lock and from the newly activated release. Timer
    // updates enter update-locked directly and never request agent consent.
    return connectAgents(base, config.node);
  }
  if (command === 'logs') return run('journalctl', ['--user', '-u', 'garnet.service', '-n', '80', '-f']);
  if (command === 'url') { console.log(`http://127.0.0.1:${await appPort(await readConfig(base))}`); return; }
  if (command === 'port') {
    const config = await readConfig(base);
    config.port = validPort(positional[0]);
    await atomicJSON(path.join(base, 'install.json'), config);
    await rm(path.join(config.data, 'runtime/listen.json'), { force: true });
    ctl('restart', 'garnet.service'); await healthy(config, base);
    console.log(`http://127.0.0.1:${await appPort(config)} — update your tunnel route to this HTTP address.`); return;
  }
  if (command === 'status') {
    const config = await readConfig(base);
    console.log(`App: http://127.0.0.1:${await appPort(config)}\nMongoDB: ${new URL(config.database.uri).host}`);
    ctl('status', 'garnet.service', '--no-pager'); return ctl('list-timers', 'garnet-update.timer', '--no-pager');
  }
  if (command === 'start' || command === 'stop') {
    ctl(command, 'garnet.service');
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
  console.log('Usage: garnet {mcp|start|stop|url|port NUMBER|status|logs|update|uninstall [--yes]|autoupdate on|off|status}');
}
// The garnet command runs this file through the `current` symlink, and Node reports the release's real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
