import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
// The demo uses its own database and directories; the production library is untouched.
for (const name of ['promo-documents', 'promo-runtime', 'promo-workspace']) await mkdir(`data/${name}`, { recursive: true });
const child = spawn(process.execPath, ['build/server.mjs', '--mongo', 'mongodb://127.0.0.1:27018/ed_promo', '--port', '8082', '--storage', 'data/promo-documents', '--runtime', 'data/promo-runtime'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
console.log('Demo app and agents: http://127.0.0.1:8082 · Ctrl+C to stop');
