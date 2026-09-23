import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const version = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(version || '')) throw Error('Usage: node scripts/package-release.mjs v1.2.3');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'garnet-release-'));
try {
  await cp('build', path.join(temporary, 'build'), { recursive: true });
  await mkdir(path.join(temporary, 'scripts'));
  for (const file of ['manage.mjs', 'service.mjs', 'install-lib.mjs']) await cp(`scripts/${file}`, path.join(temporary, 'scripts', file));
  for (const file of ['package.json', 'package-lock.json', 'LICENSE']) await cp(file, path.join(temporary, file));
  await writeFile(path.join(temporary, 'VERSION'), `${version}\n`);
  await mkdir('build/release', { recursive: true });
  const archive = path.resolve('build/release/garnet-linux.tar.gz');
  // Whitelist contents: never package host data, credentials, or node_modules.
  await rm(path.join(temporary, 'build/release'), { recursive: true, force: true });
  execFileSync('tar', ['-czf', archive, '-C', temporary, 'build', 'scripts', 'package.json', 'package-lock.json', 'LICENSE', 'VERSION']);
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile('build/release/SHA256SUMS', `${hash}  garnet-linux.tar.gz\n`);
  console.log(`Packaged ${version}: ${archive}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
