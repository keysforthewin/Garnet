import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, open } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import path from 'node:path';
const root = process.cwd();
const runtime = path.join(root, 'data/test-runtime');
const pidFile = path.join(runtime, 'server.pid');
export async function stopTestApp() {
  const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
  if (!pid) return;
  const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  if (command.includes(path.join(root, 'build/server.mjs')) && command.includes(runtime)) {
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (!state || state.split(') ')[1]?.startsWith('Z')) break;
      if (attempt === 99) throw new Error('Test app did not shut down.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await unlink(pidFile).catch(() => {});
}
export async function startTestApp(reset = false) {
  await stopTestApp();
  if (reset) {
    const mongo = await new MongoClient('mongodb://127.0.0.1:27018/ed_test').connect();
    try { await mongo.db().dropDatabase(); } finally { await mongo.close(); }
  }
  await mkdir(runtime, { recursive: true });
  await mkdir(path.join(root, 'data/test-documents'), { recursive: true });
  const log = await open(path.join(runtime, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(root, 'build/server.mjs'), '--mongo', 'mongodb://127.0.0.1:27018/ed_test', '--port', '8081', '--runtime', runtime, '--storage', path.join(root, 'data/test-documents')], { detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref(); await log.close();
  await writeFile(pidFile, String(child.pid));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch('http://127.0.0.1:8081/api/health').then(r => r.ok).catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test server failed to start. See data/test-runtime/server.log.');
}
if (process.argv[1] === path.join(root, 'scripts/test-app.mjs')) {
  if (process.argv[2] === 'stop') await stopTestApp();
  else if (process.argv[2] === 'start' || process.argv[2] === 'reset') await startTestApp(process.argv[2] === 'reset');
  else throw new Error('Usage: node scripts/test-app.mjs start|stop|reset');
}
