// Keep database credentials out of systemd units and process command lines.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
process.env.GARNET_MONGO_URI = config.database.uri;
process.env.PATH = config.path;
process.chdir(config.dataParent);
process.argv = [process.execPath, fileURLToPath(new URL('../build/server.mjs', import.meta.url)),
  '--storage', path.join(config.data, 'documents'), '--runtime', path.join(config.data, 'runtime'),
  '--caddy-data', path.join(config.data, 'caddy-host')];
await import('../build/server.mjs');
