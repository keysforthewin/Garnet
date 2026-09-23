import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

async function fixture(t, scenario = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'garnet-host-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, 'home/.config/systemd/user'), { recursive: true });
  await mkdir(path.join(base, 'bin'));
  await writeFile(path.join(base, 'bin/docker'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  await writeFile(path.join(base, 'scenario.json'), JSON.stringify(scenario));
  return base;
}
async function install(base, name, args = []) {
  const stage = path.join(base, `releases/.stage.${name}`);
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, 'VERSION'), 'v1.0.0\n');
  return spawnSync(process.execPath, ['--import', path.resolve('tests/fixtures/installer-host.mjs'), 'scripts/manage.mjs', 'install', `--root=${base}`, `--stage=${stage}`, ...args], {
    env: { ...process.env, PATH: `${path.join(base, 'bin')}:${process.env.PATH}`, GARNET_TEST_ROOT: base }, encoding: 'utf8', timeout: 15000,
  });
}
const commands = async base => (await readFile(path.join(base, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
test('installer creates user services, a private config, and a working managed launcher', async t => {
  const base = await fixture(t);
  const result = await install(base, 'first');
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(path.join(base, 'install.json'), 'utf8'));
  assert.equal(config.database.uri, 'mongodb://127.0.0.1:27017/garnet');
  const unit = await readFile(path.join(base, 'home/.config/systemd/user/garnet.service'), 'utf8');
  assert.match(unit, /current\/scripts\/service.mjs/);
  assert.match(unit, /\nWorkingDirectory=\//);
  assert.doesNotMatch(unit, /mongodb:/);
  const timer = await readFile(path.join(base, 'home/.config/systemd/user/garnet-update.timer'), 'utf8');
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /OnCalendar=daily/);
  assert.match(await readlink(path.join(base, 'current')), /releases\/v1.0.0-/);
  const launcher = path.join(base, 'home/.local/bin/garnet');
  assert.equal(spawnSync('sh', ['-n', launcher]).status, 0);
  assert.ok((await commands(base)).some(parts => parts.includes('enable-linger')));
});
test('installer preserves native source data and restores the source service if activation fails', async t => {
  const base = await fixture(t);
  const legacy = path.join(base, 'source');
  await mkdir(path.join(legacy, 'data/mongo-host'), { recursive: true });
  const original = '[Unit]\nDescription=Existing source service\n';
  const unit = path.join(base, 'home/.config/systemd/user/garnet.service');
  await writeFile(unit, original);
  await writeFile(path.join(legacy, 'data/mongo-host/notes'), 'original database files');
  await writeFile(path.join(base, 'scenario.json'), JSON.stringify({ legacy, failRestart: true }));
  const result = await install(base, 'failed');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Simulated start failure/);
  assert.equal(await readFile(unit, 'utf8'), original);
  assert.equal(await readFile(path.join(legacy, 'data/mongo-host/notes'), 'utf8'), 'original database files');
  await writeFile(path.join(base, 'scenario.json'), '{}');
  const retry = await install(base, 'retry');
  assert.equal(retry.status, 0, retry.stderr);
  const config = JSON.parse(await readFile(path.join(base, 'install.json'), 'utf8'));
  assert.equal(config.data, path.join(legacy, 'data'));
  assert.equal(config.database.uri, 'mongodb://127.0.0.1:27018/ed');
});
test('occupied app port aborts before creating services or enabling startup', async t => {
  const base = await fixture(t, { occupied: true });
  const result = await install(base, 'occupied');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Port 7777 is already occupied/);
  assert.ok(!(await commands(base)).some(parts => parts.includes('enable-linger')));
  await assert.rejects(readFile(path.join(base, 'install.json')), { code: 'ENOENT' });
});
test('automatic container install pins the image and reinstallation preserves the volume and update preference', async t => {
  const base = await fixture(t, { noHost: true });
  const result = await install(base, 'container');
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(base, 'install.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.database.kind, 'container');
  assert.match(config.database.image, /@sha256:/);
  assert.equal(config.database.volume, 'garnet-mongo');
  config.autoUpdate = false;
  await writeFile(file, JSON.stringify(config));
  await writeFile(path.join(base, 'commands.jsonl'), '');
  const again = await install(base, 'again');
  assert.equal(again.status, 0, again.stderr);
  const calls = await commands(base);
  assert.ok(!calls.some(parts => ['docker', 'podman'].includes(path.basename(parts[0])) && parts.includes('create')));
  assert.ok(!calls.some(parts => parts.includes('enable') && parts.includes('garnet-update.timer')));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).database, config.database);
});
