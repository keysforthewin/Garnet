import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function validPort(value) {
  const port = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Choose a port from 1024 to 65535.');
  return port;
}
export async function listenAvailable(server, preferred = 7777, host = '127.0.0.1', excluded = []) {
  let port = validPort(preferred);
  for (let attempt = 0; attempt < 64512; attempt++, port = port === 65535 ? 1024 : port + 1) {
    if (excluded.includes(port)) continue;
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready);
        server.listen(port, host);
      });
      return port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw Error('No available unprivileged TCP port.');
}
export async function availablePort(preferred, excluded = []) {
  const server = createServer();
  const port = await listenAvailable(server, preferred, '127.0.0.1', excluded);
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
export async function appPort(config) {
  try { return validPort(JSON.parse(await readFile(path.join(config.data, 'runtime/listen.json'), 'utf8')).port); }
  catch { return validPort(config.port || 7777); }
}
