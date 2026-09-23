import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, writeFile, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chooseDatabase, parseOptions, stableRelease, verifyArchive, activateRelease, pointCurrent, atomicJSON, quoteUnit, quoteExec } from '../scripts/install-lib.mjs';

const unavailable = async () => { throw Error('unavailable'); };
test('automatic database selection reuses a host before choosing a container', async () => {
  const seen = [];
  const host = await chooseDatabase({ probe: async uri => { seen.push(uri); } });
  assert.deepEqual(host, { kind: 'host', uri: 'mongodb://127.0.0.1:27017/garnet' });
  assert.equal(seen.length, 1);
  const fallback = await chooseDatabase({ probe: unavailable });
  assert.equal(fallback.kind, 'container');
  assert.equal(fallback.uri, 'mongodb://127.0.0.1:27018/ed');
});
test('container override never probes or adopts a host database', async () => {
  const result = await chooseDatabase({ mode: 'container', probe: () => assert.fail('Host should not be queried') });
  assert.equal(result.kind, 'container');
});
test('explicit host failures never silently create an empty container database', async () => {
  await assert.rejects(chooseDatabase({ mode: 'host', probe: unavailable }), /No compatible/);
  await assert.rejects(chooseDatabase({ uri: 'mongodb://user:secret@localhost/garnet', probe: unavailable }), /unavailable/);
});
test('reruns preserve database storage and reject implicit migrations', async () => {
  for (const existing of [{ kind: 'host', uri: 'mongodb://127.0.0.1:27018/ed' }, { kind: 'container', uri: 'mongodb://127.0.0.1:27018/ed', volume: 'existing' }]) {
    assert.equal(await chooseDatabase({ existing, probe: unavailable }), existing);
    await assert.rejects(chooseDatabase({ existing, uri: 'mongodb://elsewhere/empty', probe: unavailable }), /migration/);
    await assert.rejects(chooseDatabase({ existing, mode: existing.kind === 'host' ? 'container' : 'host', probe: unavailable }), /migration/);
  }
  const legacy = { kind: 'host', uri: 'mongodb://127.0.0.1:27018/ed', service: 'garnet-mongo.service' };
  assert.equal(await chooseDatabase({ legacy, probe: unavailable }), legacy);
  await assert.rejects(chooseDatabase({ legacy, mode: 'container', probe: unavailable }), /migration/);
});
test('option errors do not disclose URI credentials', () => {
  assert.throws(() => parseOptions(['--wrong=mongodb://user:secret@localhost']), error => !error.message.includes('secret'));
  assert.throws(() => parseOptions(['--database=container', '--mongo-uri=mongodb://localhost/test']), /cannot be combined/);
  assert.throws(() => parseOptions(['--database=typo']), /must be/);
  assert.equal(parseOptions(['--database=host']).database, 'host');
});
test('only stable versioned releases and matching archive checksums are accepted', () => {
  for (const release of [{ tag_name: 'main' }, { tag_name: 'v1.0.0-rc.1' }, { tag_name: 'v1.0.0', prerelease: true }, { tag_name: 'v1.0.0', draft: true }]) assert.throws(() => stableRelease(release));
  assert.equal(stableRelease({ tag_name: 'v1.2.3' }), 'v1.2.3');
  const archive = Buffer.from('complete release');
  const sums = `${createHash('sha256').update(archive).digest('hex')}  garnet-linux.tar.gz\n`;
  verifyArchive(archive, sums);
  assert.throws(() => verifyArchive(archive.subarray(1), sums), /checksum/);
  assert.throws(() => verifyArchive(archive, sums.replace('garnet-linux', 'other')), /checksum/);
});
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'garnet-install-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const previous = path.join(base, 'releases/old'), next = path.join(base, 'releases/new');
  await mkdir(previous, { recursive: true }); await mkdir(next);
  await mkdir(path.join(base, 'data'));
  await writeFile(path.join(base, 'data/notes'), 'keep all notes');
  return { base, previous, next };
}
test('successful activation switches atomically and retains the previous release and data', async t => {
  const { base, previous, next } = await fixture(t);
  await pointCurrent(base, previous);
  const result = await activateRelease(base, next, {
    restart: async () => assert.equal(await readlink(path.join(base, 'current')), next), healthy: async () => {},
  });
  assert.equal(result, previous);
  assert.equal(await readFile(path.join(base, 'data/notes'), 'utf8'), 'keep all notes');
  assert.ok((await stat(previous)).isDirectory());
});
test('failed health check or restart rolls back the app without rolling back data', async t => {
  for (const failure of ['health', 'restart']) {
    const { base, previous, next } = await fixture(t);
    await pointCurrent(base, previous);
    let restarts = 0;
    await assert.rejects(activateRelease(base, next, {
      restart: async () => { restarts++; if (failure === 'restart' && restarts === 1) throw Error('cannot start'); },
      healthy: async () => { if (restarts === 1) throw Error('bad health'); },
    }), /restored previous/);
    assert.equal(restarts, 2);
    assert.equal(await readlink(path.join(base, 'current')), previous);
    assert.equal(await readFile(path.join(base, 'data/notes'), 'utf8'), 'keep all notes');
  }
});
test('failed first install removes its broken current link, and failed rollback is explicit', async t => {
  const { base, previous, next } = await fixture(t);
  await assert.rejects(activateRelease(base, next, { restart: unavailable, healthy: unavailable }), /activation failed/);
  await assert.rejects(readlink(path.join(base, 'current')), { code: 'ENOENT' });
  await pointCurrent(base, previous);
  await assert.rejects(activateRelease(base, next, { restart: unavailable, healthy: unavailable }), /previous release could not restart/);
  assert.equal(await readlink(path.join(base, 'current')), previous);
});
test('connection configuration remains private across atomic rewrites', async t => {
  const { base } = await fixture(t);
  const file = path.join(base, 'install.json');
  await atomicJSON(file, { uri: 'mongodb://user:secret@localhost/notes' });
  await atomicJSON(file, { uri: 'mongodb://user:changed@localhost/notes' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).uri, 'mongodb://user:changed@localhost/notes');
});
test('systemd escaping distinguishes literal settings from command expansion', () => {
  const value = '/home/a $USER/100%/"notes"';
  assert.equal(quoteUnit(value), '"/home/a $USER/100%%/\\"notes\\""');
  assert.equal(quoteExec(value), '"/home/a $$USER/100%%/\\"notes\\""');
  assert.ok(!quoteUnit('line\nbreak').includes('\n'));
});
test('installation lock excludes a concurrent update', async t => {
  const { base } = await fixture(t);
  const lock = path.join(base, 'install.lock');
  const holder = spawn('flock', ['-n', lock, process.execPath, '-e', 'console.log("locked");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
  t.after(() => { try { process.kill(-holder.pid, 'SIGTERM'); } catch {} });
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', code => reject(Error(`Lock holder exited ${code}`))); });
  assert.equal(spawnSync('flock', ['-n', '-E', '75', lock, process.execPath, '-e', 'process.exit(0)']).status, 75);
});
