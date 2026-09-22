import { mkdir, access, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// The existing Mongo service is shared, but ed_promo and all host mounts are isolated.
const root = process.cwd();
await access(path.join(root, 'build/server.mjs'));
for (const name of ['promo-documents', 'promo-runtime', 'promo-workspace']) await mkdir(path.join(root, 'data', name), { recursive: true });
const quote = value => JSON.stringify(value); // YAML quoted values, never shell interpolation.
await writeFile('data/promo-compose.yaml', `services:
  promo-app:
    image: node:22-bookworm-slim
    user: "${process.getuid()}:${process.getgid()}"
    working_dir: /app
    command: [node, server.mjs, --mongo, "mongodb://mongo:27017/ed_promo"]
    volumes:
      - ${quote(`${root}/build:/app:ro`)}
      - ${quote(`${root}/data/promo-documents:/documents`)}
      - ${quote(`${root}/data/promo-runtime:/runtime`)}
    ports:
      - "127.0.0.1:8082:7777"
    networks: [backend, web]
`);
const run = spawnSync('docker', ['compose', '-f', 'compose.yaml', '-f', 'data/promo-compose.yaml', 'up', '-d', 'promo-app'], { stdio: 'inherit' });
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status || 1);
console.log('Demo app: http://127.0.0.1:8082');
console.log('In a separate terminal: node build/runner.mjs --runtime data/promo-runtime');
