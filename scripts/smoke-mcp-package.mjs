// Install the actual npm tarball into an isolated directory and run its public bin.
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const directory = await mkdtemp(path.join(os.tmpdir(), 'garnet-npm-smoke-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', './packages/garnet-mcp', '--json', '--pack-destination', directory], { encoding: 'utf8' }));
  execFileSync('npm', ['install', '--prefix', directory, path.join(directory, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(directory, 'node_modules/garnet-mcp/cli.mjs'), '--help'], { stdio: 'inherit' });
} finally { await rm(directory, { recursive: true, force: true }); }
