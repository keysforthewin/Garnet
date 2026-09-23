import { mkdir, writeFile, access, readFile, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { availablePort, appPort } from './ports.mjs';
import { parseOptions, quoteExec, quoteUnit, atomicJSON } from './install-lib.mjs';
import { retireHttps } from './retire-https.mjs';

const root = process.cwd();
const data = path.join(root, 'data');
const units = path.join(os.homedir(), '.config/systemd/user');
const options = parseOptions(process.argv.slice(2));
const configFile = path.join(data, 'runtime/source-install.json');
const previous = JSON.parse(await readFile(configFile, 'utf8').catch(() => '{}'));
const active = name => spawnSync('systemctl', ['--user', 'is-active', '--quiet', name]).status === 0;
const executable = name => {
  const local = path.join(os.homedir(), '.local/lib/garnet', name);
  if (existsSync(local)) return local;
  try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const mongod = executable('mongod');
if (!mongod || !/db version v(?:[89]|[1-9]\d)\./.test(execFileSync(mongod, ['--version'], { encoding: 'utf8' }))) throw new Error('Install MongoDB 8+ on the host and add mongod to PATH first.');
await access('build/server.mjs');
await mkdir(units, { recursive: true });
for (const name of ['mongo-host', 'documents', 'runtime']) await mkdir(path.join(data, name), { recursive: true });
const preferred = options.port || await appPort({ data, port: previous.port });
const port = active('garnet.service') ? preferred : await availablePort(preferred);
const mongoPort = active('garnet-mongo.service') ? previous.mongoPort || 27018 : await availablePort(previous.mongoPort || 27018, [port]);
const config = { port, mongoPort };
await atomicJSON(configFile, config);
if (options.port) await rm(path.join(data, 'runtime/listen.json'), { force: true });
await retireHttps();
const unit = (description, command, extra = '') => `[Unit]\nDescription=${description}\nAfter=network.target\nStartLimitIntervalSec=0\n${extra}\n[Service]\nType=simple\nWorkingDirectory=${root.replaceAll('%', '%%')}\nExecStart=${command.map(quoteExec).join(' ')}\nEnvironment=${quoteUnit(`PATH=${process.env.PATH}`)}\nRestart=on-failure\nRestartSec=3\nKillMode=mixed\nTimeoutStopSec=45\n\n[Install]\nWantedBy=default.target\n`;
await writeFile(path.join(units, 'garnet-mongo.service'), unit('Garnet database', [mongod, '--dbpath', path.join(data, 'mongo-host'), '--bind_ip', '127.0.0.1', '--port', String(mongoPort)]));
await writeFile(path.join(units, 'garnet.service'), unit('Garnet notes and agents', [process.execPath, path.join(root, 'scripts/source-service.mjs')], 'Wants=garnet-mongo.service\nAfter=garnet-mongo.service'));
const ctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
ctl('daemon-reload');
for (const legacy of ['garnet-runner.service', 'ed-runner.service']) {
  try { execFileSync('systemctl', ['--user', 'cat', legacy], { stdio: 'ignore' }); ctl('disable', '--now', legacy); } catch {}
}
ctl('enable', '--now', 'garnet-mongo.service');
ctl('enable', 'garnet.service');
ctl('restart', 'garnet.service');
let ready = false;
for (let attempt = 0; attempt < 90; attempt++) {
  const actualPort = await appPort({ data, port });
  if (await fetch(`http://127.0.0.1:${actualPort}/api/health`).then(r => r.ok).catch(() => false)) { ready = true; break; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!ready) throw new Error('Garnet did not become healthy. Check ./garnet logs.');
console.log(`Garnet installed: http://127.0.0.1:${await appPort({ data, port })}\nMongoDB: 127.0.0.1:${mongoPort}`);
