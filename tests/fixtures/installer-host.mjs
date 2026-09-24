// Fail-closed host simulator for installer process tests. Never invokes host commands.
import childProcess from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, appendFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const base = process.env.GARNET_TEST_ROOT;
if (!base?.includes('garnet-host-test-')) throw Error('Expected isolated installer fixture directory.');
const scenario = JSON.parse(readFileSync(path.join(base, 'scenario.json'), 'utf8'));
os.homedir = () => path.join(base, 'home');
os.userInfo = () => ({ username: 'fixture', uid: 1000, gid: 1000 });
let databaseStarted = false, restartFailed = false;
const record = (command, args) => appendFileSync(path.join(base, 'commands.jsonl'), `${JSON.stringify([command, ...args])}\n`);
childProcess.spawnSync = (command, args) => {
  record(command, args);
  const name = path.basename(command);
  let status = 1;
  if (name === 'systemctl') {
    if (args.includes('show-environment') || args.includes('is-active')) status = 0;
    if (args.includes('is-enabled')) status = scenario.legacy || args.includes('docker.service') ? 0 : 1;
  } else if (name === 'loginctl') status = 0;
  else if (name === 'podman' || name === 'docker') {
    status = args[0] === 'info' && name === 'docker' ? 0 : 1;
    if (args[1] === 'inspect') status = existsSync(path.join(base, `mock-${args[0]}`)) ? 0 : 1;
  }
  else throw Error(`Simulator refused command: ${name}`);
  return { status };
};
childProcess.execFileSync = (command, args) => {
  record(command, args);
  const name = path.basename(command);
  if (name === 'systemctl') {
    if (args.includes('show')) {
      if (args.includes('--property=WorkingDirectory')) return scenario.legacy || '';
      if (args.includes('--property=ExecStart')) return `argv[]=/usr/bin/node ${scenario.legacy}/build/server.mjs ;`;
      if (args.includes('--property=MainPID')) return '4242';
    }
    if (args.includes('enable') && args.includes('garnet-mongo.service')) databaseStarted = true;
    if (scenario.failRestart && !restartFailed && args.includes('restart') && args.includes('garnet.service')) { restartFailed = true; throw Error('Simulated start failure'); }
    if (args.includes('restart') && args.includes('garnet.service')) {
      const config = JSON.parse(readFileSync(path.join(base, 'install.json'), 'utf8'));
      writeFileSync(path.join(config.data, 'runtime/listen.json'), JSON.stringify({ port: config.port || 7777, pid: 4242 }));
    }
    return '';
  }
  if (name === 'loginctl') return 'yes';
  if (name === 'flock' && args.includes('update-locked')) {
    if (scenario.failUpdate) throw Error('Simulated update failure');
    return '';
  }
  if (name === 'npm' && args[0] === 'exec' && args.some(arg => arg.startsWith('--package=garnet-mcp@')) && args.includes('setup')) {
    if (scenario.failMcp) throw Error('Simulated npm setup failure');
    return '';
  }
  if (name === 'docker' || name === 'podman') {
    const state = kind => path.join(base, `mock-${kind}`);
    if (args[1] === 'inspect' && ['container', 'volume'].includes(args[0])) {
      if (!existsSync(state(args[0]))) throw Object.assign(Error('missing'), { stderr: 'No such object' });
      if (args[0] === 'volume') return JSON.stringify([{ Labels: { app: scenario.foreignVolume ? 'other' : 'garnet' } }]);
      return JSON.stringify([{ State: { Running: !scenario.stoppedContainer }, Config: { Labels: { app: 'garnet' } }, Mounts: [{ Name: 'garnet-mongo', Destination: '/data/db' }] }]);
    }
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ RepoDigests: [`docker.io/library/mongo@sha256:${'a'.repeat(64)}`] }]);
    if (args[0] === 'pull') { writeFileSync(state('image'), ''); return ''; }
    if (args[0] === 'volume' && args[1] === 'create') { writeFileSync(state('volume'), 'notes'); return ''; }
    if (args[0] === 'create') {
      if (scenario.failCreate) throw Error('Simulated container creation failure');
      writeFileSync(state('container'), ''); return '';
    }
    if (args[0] === 'rm') { unlinkSync(state('container')); return ''; }
    if (args[1] === 'rm') { unlinkSync(state(args[0])); return ''; }

  }
  throw Error(`Simulator refused command: ${name}`);
};
net.createServer = () => {
  const server = new EventEmitter();
  server.listen = (port, _host) => {
    if ((scenario.occupied && [7777, 27018].includes(port)) || scenario.occupiedPorts?.includes(port)) server.emit('error', Object.assign(Error('occupied'), { code: 'EADDRINUSE' }));
    else server.emit('listening');
  };
  server.close = callback => callback();
  return server;
};
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify({ tag_name: 'v1.0.0', draft: false, prerelease: false })) });
MongoClient.prototype.connect = async function () {
  if (scenario.noHost && !databaseStarted) throw Error('No host database');
  return this;
};
MongoClient.prototype.db = () => ({ command: async () => ({ version: '8.0.0' }), listCollections: () => ({ toArray: async () => [] }) });
MongoClient.prototype.close = async () => {};
syncBuiltinESMExports();
