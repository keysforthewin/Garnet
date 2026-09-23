// Fail-closed host simulator for installer process tests. Never invokes host commands.
import childProcess from 'node:child_process';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, appendFileSync } from 'node:fs';
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
  else if (name === 'podman' || name === 'docker') status = args[0] === 'info' && name === 'docker' ? 0 : 1;
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
    }
    if (args.includes('enable') && args.includes('garnet-mongo.service')) databaseStarted = true;
    if (scenario.failRestart && !restartFailed && args.includes('restart') && args.includes('garnet.service')) { restartFailed = true; throw Error('Simulated start failure'); }
    return '';
  }
  if (name === 'loginctl') return 'yes';
  if (name === 'docker' || name === 'podman') {
    if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ RepoDigests: [`docker.io/library/mongo@sha256:${'a'.repeat(64)}`] }]);
    if (['pull', 'volume', 'create'].includes(args[0])) return '';
  }
  throw Error(`Simulator refused command: ${name}`);
};
net.createServer = () => {
  const server = new EventEmitter();
  server.listen = (_port, _host, callback) => { if (scenario.occupied) server.emit('error', Error('occupied')); else callback(); };
  server.close = callback => callback();
  return server;
};
globalThis.fetch = async () => ({ ok: true });
MongoClient.prototype.connect = async function () {
  if (scenario.noHost && !databaseStarted) throw Error('No host database');
  return this;
};
MongoClient.prototype.db = () => ({ command: async () => ({ version: '8.0.0' }), listCollections: () => ({ toArray: async () => [] }) });
MongoClient.prototype.close = async () => {};
syncBuiltinESMExports();
