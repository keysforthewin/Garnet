import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validPort, listenAvailable, availablePort, appPort } from '../scripts/ports.mjs';

test('port options reject malformed, privileged and out-of-range values', () => {
  for (const value of ['bad', '7777abc', 0, 80, 65536, 7777.5, '']) assert.throws(() => validPort(value), /1024/);
  assert.equal(validPort('8888'), 8888);
});
test('HTTP listening skips occupied ports and keeps the selected socket bound', async t => {
  const busy = createServer(), app = createServer();
  t.after(() => { busy.close(); app.close(); });
  await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  const preferred = busy.address().port;
  const chosen = await listenAvailable(app, preferred);
  assert.notEqual(chosen, preferred);
  assert.equal(app.address().port, chosen);
  const probe = createServer();
  const error = await new Promise(resolve => { probe.once('error', resolve); probe.listen(chosen, '127.0.0.1'); });
  assert.equal(error.code, 'EADDRINUSE');
});
test('database port selection excludes the selected HTTP port', async () => {
  const first = await availablePort(27777);
  const second = await availablePort(first, [first]);
  assert.notEqual(second, first);
});
test('saved actual port survives restarts and URL lookup', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'garnet-ports-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  assert.equal(await appPort({ data, port: 8888 }), 8888);
  await mkdir(path.join(data, 'runtime'));
  await writeFile(path.join(data, 'runtime/listen.json'), JSON.stringify({ port: 8889 }));
  assert.equal(await appPort({ data, port: 8888 }), 8889);
});
