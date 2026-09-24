import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
export async function launchMcp(root) {
  let config;
  try { config = JSON.parse(await readFile(path.join(root, 'install.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runtime = path.join(config?.data || path.join(root, 'data'), 'runtime');
  const child = spawn(config?.node || process.execPath, [path.join(root, config ? 'current/build/tools.mjs' : 'build/tools.mjs'), '--socket', path.join(runtime, 'app.sock'), '--credential-file', path.join(runtime, 'mcp-token')], { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
