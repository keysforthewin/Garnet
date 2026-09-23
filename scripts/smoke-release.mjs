// Isolated production-archive smoke test. No host ports, services, or data are used.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyArchive } from './install-lib.mjs';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'garnet-release-smoke-'));
const prefix = `garnet-release-test-${process.pid}`;
const database = `${prefix}-db`, app = `${prefix}-app`;
const docker = args => execFileSync('docker', args, { stdio: 'inherit' });
try {
  const archive = path.resolve('build/release/garnet-linux.tar.gz');
  verifyArchive(await readFile(archive), await readFile('build/release/SHA256SUMS', 'utf8'));
  execFileSync('tar', ['-xzf', archive, '-C', temporary]);
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary, stdio: 'inherit' });
  await writeFile(path.join(temporary, 'smoke-config.json'), JSON.stringify({ database: { uri: `mongodb://${database}:27017/release_test` }, data: '/work/data', dataParent: '/work', path: '/usr/local/bin:/usr/bin:/bin' }));
  docker(['network', 'create', prefix]);
  docker(['run', '-d', '--name', database, '--network', prefix, 'mongo:8.0']);
  docker(['run', '-d', '--name', app, '--network', prefix, '--mount', `type=bind,src=${temporary},dst=/app,readonly`, '--tmpfs', '/work', '--workdir', '/app', 'node:24-bookworm-slim',
    'sh', '-c', 'node --input-type=module -e \'import {MongoClient} from "mongodb"; import {readFile} from "node:fs/promises"; const c = JSON.parse(await readFile("smoke-config.json")); const m = await new MongoClient(c.database.uri, {serverSelectionTimeoutMS:60000}).connect(); await m.close();\' && exec node scripts/service.mjs smoke-config.json']);
  docker(['exec', app, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    let response;
    for (let i=0; i<90; i++) {
      response = await fetch('http://127.0.0.1:7777/api/health').catch(()=>null);
      if(response?.ok) break;
      await new Promise(r=>setTimeout(r,1000));
    }
    assert.equal(response?.status,200);
    assert.match(await fetch('http://127.0.0.1:7777').then(r=>r.text()), /<html/);
    const login=await fetch('http://127.0.0.1:7777/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'password'})});
    assert.equal(login.status,200);
    console.log('Packaged app healthy; frontend and first login work with production-only dependencies.');
  `]);
} catch (error) {
  try { docker(['logs', app]); } catch {}
  throw error;
} finally {
  for (const name of [app, database]) { try { execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' }); } catch {} }
  try { execFileSync('docker', ['network', 'rm', prefix], { stdio: 'ignore' }); } catch {}
  await rm(temporary, { recursive: true, force: true });
}
