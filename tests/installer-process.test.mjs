import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

async function fixture(t, scenario = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'garnet-host-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = await mkdtemp(path.join(os.tmpdir(), 'garnet-user-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await symlink(home, path.join(base, 'home'));
  await mkdir(path.join(home, '.config/systemd/user'), { recursive: true });
  await mkdir(path.join(base, 'bin'));
  await writeFile(path.join(base, 'bin/docker'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  await writeFile(path.join(base, 'scenario.json'), JSON.stringify(scenario));
  return base;
}
async function install(base, name, args = []) {
  const stage = path.join(base, `releases/.stage.${name}`);
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, 'VERSION'), 'v1.0.0\n');
  await mkdir(path.join(stage, 'scripts'));
  await writeFile(path.join(stage, 'scripts/ports.mjs'), '// Current release marker for health checks.\n');
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
test('occupied HTTP and database ports select available alternatives automatically', async t => {
  const base = await fixture(t, { occupied: true, noHost: true });
  const result = await install(base, 'occupied');
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(path.join(base, 'install.json'), 'utf8'));
  assert.equal(config.port, 7778);
  assert.equal(config.database.port, 27019);
  assert.equal(config.database.uri, 'mongodb://127.0.0.1:27019/ed');
  assert.match(result.stdout, /http:\/\/127.0.0.1:7778/);
  assert.ok((await commands(base)).some(parts => parts.includes('127.0.0.1:27019:27017')));
});
test('explicit HTTP port is honored and cannot collide with the managed database port', async t => {
  const base = await fixture(t, { noHost: true });
  const result = await install(base, 'custom', ['--port=27018']);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(path.join(base, 'install.json'), 'utf8'));
  assert.equal(config.port, 27018);
  assert.equal(config.database.port, 27019);
});
test('installation retires old HTTPS without creating a replacement listener', async t => {
  const base = await fixture(t);
  const https = path.join(base, 'home/.config/systemd/user/garnet-https.service');
  await writeFile(https, '[Service]\nExecStart=/old/caddy\n');
  const result = await install(base, 'http-only');
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(https), { code: 'ENOENT' });
  const calls = await commands(base);
  assert.ok(calls.some(parts => parts.includes('disable') && parts.includes('garnet-https.service')));
  assert.ok(!calls.some(parts => parts.includes('enable') && parts.includes('garnet-https.service')));
  assert.equal('caddy' in JSON.parse(await readFile(path.join(base, 'install.json'), 'utf8')), false);
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

test('an interrupted container creation resumes with the original volume', async t => {
  const base = await fixture(t, { noHost: true, failCreate: true });
  const first = await install(base, 'interrupted');
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /Simulated container creation failure/);
  assert.equal(await readFile(path.join(base, 'mock-volume'), 'utf8'), 'notes');
  await writeFile(path.join(base, 'scenario.json'), JSON.stringify({ noHost: true }));
  await writeFile(path.join(base, 'commands.jsonl'), '');
  const retry = await install(base, 'resumed');
  assert.equal(retry.status, 0, retry.stderr);
  const calls = await commands(base);
  assert.ok(!calls.some(parts => parts.includes('volume') && parts.includes('create')));
  assert.ok(!calls.some(parts => parts.includes('pull')));
  assert.equal(await readFile(path.join(base, 'mock-volume'), 'utf8'), 'notes');
});

async function removeInstallation(base) {
  return spawnSync(process.execPath, ['--import', path.resolve('tests/fixtures/installer-host.mjs'), 'scripts/manage.mjs', 'uninstall-locked', `--root=${base}`], {
    env: { ...process.env, GARNET_TEST_ROOT: base }, encoding: 'utf8', timeout: 15000,
  });
}
for (const container of [true, false]) test(`uninstall cleans managed files and ${container ? 'removes managed MongoDB' : 'preserves host MongoDB'}`, async t => {
  const base = await fixture(t, { noHost: container });
  assert.equal((await install(base, 'first')).status, 0);
  const home = await readlink(path.join(base, 'home'));
  const result = await removeInstallation(base);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(path.join(base, 'install.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(home, '.local/bin/garnet')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(home, '.config/systemd/user/garnet.service')), { code: 'ENOENT' });
  if (!container) assert.match(result.stdout, /host MongoDB.*preserved/);
});
test('uninstall refuses a database volume without ownership labels', async t => {
  const base = await fixture(t, { noHost: true });
  assert.equal((await install(base, 'first')).status, 0);
  await writeFile(path.join(base, 'scenario.json'), JSON.stringify({ foreignVolume: true }));
  const result = await removeInstallation(base);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership/);
  assert.equal(await readFile(path.join(base, 'mock-volume'), 'utf8'), 'notes');
});
