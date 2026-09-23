// Keep database credentials out of systemd units and process command lines.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPort } from './ports.mjs';
import { atomicJSON } from './install-lib.mjs';
import { retireHttps } from './retire-https.mjs';
const configFile = path.resolve(process.argv[2]);
const config = JSON.parse(await readFile(configFile, 'utf8'));
await retireHttps(Boolean(config.caddy));
if ('caddy' in config) { delete config.caddy; await atomicJSON(configFile, config); }
process.env.GARNET_MONGO_URI = config.database.uri;
process.env.PATH = config.path;
process.chdir(config.dataParent);
process.argv = [process.execPath, fileURLToPath(new URL('../build/server.mjs', import.meta.url)),
  '--port', String(await appPort(config)), '--storage', path.join(config.data, 'documents'), '--runtime', path.join(config.data, 'runtime')];
await import('../build/server.mjs');
