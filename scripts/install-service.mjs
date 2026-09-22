import { mkdir, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

const root = process.cwd();
const units = path.join(os.homedir(), '.config/systemd/user');
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const executable = name => {
  const local = path.join(os.homedir(), '.local/lib/garnet', name);
  if (existsSync(local)) return local;
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const mongod = executable('mongod');
if (!mongod || !/db version v(?:[89]|[1-9]\d)\./.test(execFileSync(mongod, ['--version'], { encoding: 'utf8' }))) throw new Error('Install MongoDB 8+ on the host and add mongod to PATH first.');
await access('build/server.mjs');
await mkdir(units, { recursive: true });
for (const name of ['mongo-host', 'documents', 'runtime', 'caddy-host']) await mkdir(path.join(root, 'data', name), { recursive: true });
const unit = (description, command, extra = '') => `[Unit]\nDescription=${description}\nAfter=network.target\n${extra}\n[Service]\nType=simple\nWorkingDirectory=${root.replaceAll('%', '%%')}\nExecStart=${command.map(quote).join(' ')}\nEnvironment=${quote(`PATH=${process.env.PATH}`)}\nRestart=on-failure\nRestartSec=3\nKillMode=mixed\nTimeoutStopSec=45\n\n[Install]\nWantedBy=default.target\n`;
await writeFile(path.join(units, 'garnet-mongo.service'), unit('Garnet database', [mongod, '--dbpath', path.join(root, 'data/mongo-host'), '--bind_ip', '127.0.0.1', '--port', '27018']));
await writeFile(path.join(units, 'garnet.service'), unit('Garnet notes and agents', [process.execPath, path.join(root, 'build/server.mjs')], 'Requires=garnet-mongo.service\nAfter=garnet-mongo.service'));
const caddy = executable('caddy');
if (caddy) await writeFile(path.join(units, 'garnet-https.service'), unit('Garnet private HTTPS', [caddy, 'run', '--config', path.join(root, 'data/runtime/Caddyfile'), '--adapter', 'caddyfile', '--watch'], 'Requires=garnet.service\nAfter=garnet.service\nPartOf=garnet.service'));
const ctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
ctl('daemon-reload');
for (const legacy of ['garnet-runner.service', 'ed-runner.service']) {
  try { execFileSync('systemctl', ['--user', 'cat', legacy], { stdio: 'ignore' }); ctl('disable', '--now', legacy); } catch {}
}
ctl('enable', '--now', 'garnet-mongo.service', 'garnet.service');
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  if (await fetch('http://127.0.0.1:7777/api/health').then(r => r.ok).catch(() => false)) { ready = true; break; }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready) throw new Error('Garnet did not become healthy. Check ./garnet logs.');
if (caddy) ctl('enable', '--now', 'garnet-https.service');
console.log(`Garnet installed: http://localhost:7777${caddy ? ' · private HTTPS on port 8443' : ' · install Caddy and rerun install for private HTTPS'}`);
