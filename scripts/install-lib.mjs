import { validPort } from './ports.mjs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, symlink, rm, readlink } from 'node:fs/promises';
import path from 'node:path';

export const repository = 'keysforthewin/Garnet';
export const quoteUnit = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('%', '%%')}"`;
export const quoteExec = value => quoteUnit(value).replaceAll('$', () => '$$');
export function stableRelease(release) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw Error('Expected a stable versioned release.');
  return release.tag_name;
}
export function verifyArchive(bytes, checksums) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!checksums.split('\n').some(line => line.trim() === `${hash}  garnet-linux.tar.gz`)) throw Error('Release checksum mismatch.');
}
export function parseOptions(args) {
  const options = {};
  for (const arg of args) {
    if (arg === '--yes') { options.yes = true; continue; }
    const match = /^--(root|stage|database|mongo-uri|port)=(.+)$/.exec(arg);
    if (!match) throw Error(`Unknown option: ${arg.split('=')[0]}`);
    options[match[1]] = match[2];
  }
  if (options.database && !['auto', 'host', 'container'].includes(options.database)) throw Error('Database must be auto, host, or container.');
  if (options['mongo-uri'] && !/^mongodb(?:\+srv)?:\/\//.test(options['mongo-uri'])) throw Error('Expected a MongoDB connection URI.');
  if (options.database === 'container' && options['mongo-uri']) throw Error('--mongo-uri cannot be combined with --database=container.');
  if (options.port) options.port = validPort(options.port);
  return options;
}
export async function chooseDatabase({ existing, legacy, mode = 'auto', uri, probe }) {
  // Reinstallation must never select a different database implicitly or explicitly.
  if (existing) {
    if ((uri && uri !== existing.uri) || (mode !== 'auto' && mode !== existing.kind)) throw Error('Database changes require an explicit migration; the existing database was preserved.');
    return existing;
  }
  if (legacy) {
    if (mode === 'container' || (uri && uri !== legacy.uri)) throw Error('Existing native data requires migration before changing database backends.');
    return legacy;
  }
  if (uri) { await probe(uri); return { kind: 'host', uri }; }
  if (mode !== 'container') {
    for (const candidate of ['mongodb://127.0.0.1:27017/garnet', 'mongodb://127.0.0.1:27018/garnet']) {
      try { await probe(candidate); return { kind: 'host', uri: candidate }; } catch {}
    }
    if (mode === 'host') throw Error('No compatible local MongoDB found. Supply --mongo-uri, including credentials when required.');
  }
  return { kind: 'container', uri: 'mongodb://127.0.0.1:27018/ed' };
}
export async function atomicJSON(file, value) {
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}
export async function pointCurrent(root, target) {
  const temporary = path.join(root, 'current.next');
  await rm(temporary, { force: true });
  await symlink(target, temporary);
  await rename(temporary, path.join(root, 'current'));
}
export async function activateRelease(root, target, { restart, healthy }) {
  const previous = await readlink(path.join(root, 'current')).catch(() => null);
  await pointCurrent(root, target);
  try {
    await restart();
    await healthy();
  } catch (error) {
    if (previous) {
      await pointCurrent(root, previous);
      try { await restart(); await healthy(); }
      catch { throw Error('Update failed and the previous release could not restart. Inspect garnet logs.'); }
    } else await rm(path.join(root, 'current'), { force: true });
    throw Error(`Release activation failed${previous ? '; restored previous app release' : ''}: ${error.message}`);
  }
  return previous;
}
export async function readConfig(root) {
  return JSON.parse(await readFile(path.join(root, 'install.json'), 'utf8'));
}
