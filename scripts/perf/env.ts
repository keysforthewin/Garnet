import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, open, readFile, symlink, access } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import * as Y from 'yjs';
import { updateYFragment, initProseMirrorDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { schema, parseMarkdown, serializeMarkdown } from '../../shared/markdown';
import { hashPassword } from '../../server/auth';

export const USER = { id: 'perf-user', username: 'perf', password: 'perf-harness-password' };
export const DATABASE = 'garnet_perf';
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const docId = (i: number) => `perf-${String(i).padStart(4, '0')}`;
export const docTitle = (i: number) => `Perf note ${String(i).padStart(4, '0')}`;
export const LARGE_ID = 'perf-large';

async function freePort() {
  return new Promise<number>((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); }); });
}
async function reachable(uri: string) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 500 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.close(); }
}
async function stop(child: ChildProcess) { if (child.exitCode !== null) return; child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), sleep(10000)]); }

// A private mongod keeps benchmark data away from real notes and makes runs repeatable.
export async function startMongo(scratch: string, uri?: string) {
  if (uri) return { uri, stop: async () => {} };
  const port = await freePort(); const dbpath = path.join(scratch, 'mongo'); await mkdir(dbpath, { recursive: true });
  const child = spawn('mongod', ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1', '--nounixsocket', '--quiet'], { stdio: 'ignore' });
  child.on('error', () => {});
  const address = `mongodb://127.0.0.1:${port}`;
  for (let attempt = 0; !(await reachable(address)); attempt++) {
    if (child.exitCode !== null || attempt > 100) throw new Error('Could not start mongod. Install MongoDB or pass --mongo mongodb://host:port.');
    await sleep(200);
  }
  return { uri: address, stop: () => stop(child) };
}

export function normalMarkdown() {
  return Array.from({ length: 125 }, (_, i) => `Paragraph ${i + 1}. A shared notebook keeps ideas close at hand. This is a realistic short paragraph for testing local typing, search, and document navigation.`).join('\n\n');
}
// About 200 KB of mixed structure: headings, paragraphs, lists, tasks, tables and code.
export function largeMarkdown() {
  const sections: string[] = [];
  for (let s = 1; s <= 110; s++) {
    sections.push(`## Section ${s}`);
    for (let p = 1; p <= 8; p++) sections.push(`Section ${s} paragraph ${p}. Long documents stress every piece of work that scales with document size, from rendering to **serialization** and _search indexing_.`);
    sections.push(['First point', 'Second point', 'Third point'].map(item => `- ${item} in section ${s}`).join('\n'));
    sections.push(['Review draft', 'Share with the team'].map((item, i) => `- [${i ? ' ' : 'x'}] ${item} ${s}`).join('\n'));
    if (s % 10 === 0) sections.push(`| Name | Value | Notes |\n| --- | --- | --- |\n| Alpha ${s} | 1 | first |\n| Beta ${s} | 2 | second |`, '```\nconst section = ' + s + ';\nconsole.log(section);\n```');
  }
  return sections.join('\n\n');
}
function encode(markdown: string) {
  const doc = new Y.Doc(); const fragment = doc.getXmlFragment('default');
  updateYFragment(doc, fragment, schema.nodeFromJSON(parseMarkdown(markdown)), { mapping: initProseMirrorDoc(fragment, schema).mapping, isOMark: new Map() });
  const result = { state: Buffer.from(Y.encodeStateAsUpdate(doc)), markdown: serializeMarkdown(yDocToProsemirrorJSON(doc, 'default')) };
  doc.destroy(); return result;
}

export async function seed(uri: string, documents: number) {
  const client = await new MongoClient(`${uri}/${DATABASE}`).connect();
  try {
    const db = client.db(); await db.dropDatabase();
    await db.collection<any>('users').insertOne({ _id: USER.id, username: USER.username, password: await hashPassword(USER.password), admin: true, mustChangePassword: false });
    await db.collection<any>('preferences').insertOne({ _id: USER.id, value: { lastDocument: docId(0) } });
    const normal = encode(normalMarkdown()); const large = encode(largeMarkdown()); const now = Date.now();
    const record = (id: string, title: string, content: typeof normal, age: number) => ({ _id: id, title, ...content, revision: 0, mirrorRevision: -1, createdAt: now - age, updatedAt: now - age, deletedAt: null, ops: [] });
    await db.collection<any>('documents').insertMany([...Array.from({ length: documents }, (_, i) => record(docId(i), docTitle(i), normal, i * 1000)), record(LARGE_ID, 'Perf large document', large, documents * 1000)]);
    return { normalBytes: Buffer.byteLength(normal.markdown), largeBytes: Buffer.byteLength(large.markdown), normalStateBytes: normal.state.length, largeStateBytes: large.state.length };
  } finally { await client.close(); }
}

export async function startServer(buildDir: string, mongo: string, scratch: string) {
  const runtime = path.join(scratch, 'runtime'); const storage = path.join(scratch, 'documents');
  await mkdir(runtime, { recursive: true }); await mkdir(storage, { recursive: true });
  await access(path.join(buildDir, 'server.mjs')).catch(() => { throw new Error(`${buildDir}/server.mjs is missing. Run npm run build first.`); });
  const port = await freePort(); const log = await open(path.join(scratch, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(buildDir, 'server.mjs'), '--mongo', `${mongo}/${DATABASE}`, '--host', '127.0.0.1', '--port', String(port), '--runtime', runtime, '--storage', storage, '--public', path.join(buildDir, 'public')], { stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  for (let attempt = 0; ; attempt++) {
    const listen = JSON.parse(await readFile(path.join(runtime, 'listen.json'), 'utf8').catch(() => 'null'));
    const url = listen && `http://127.0.0.1:${listen.port}`;
    if (url && await fetch(`${url}/api/health`).then(r => r.ok).catch(() => false)) return { url, stop: () => stop(child) };
    if (child.exitCode !== null || attempt > 300) throw new Error(`The server did not start. See ${scratch}/server.log.`);
    await sleep(100);
  }
}

// Builds another revision in a temporary worktree so a baseline can be measured
// at any time with the current harness.
export async function buildRef(ref: string, scratch: string) {
  const dir = path.join(scratch, 'worktree');
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { stdio: 'inherit' });
  const cleanup = () => { try { execFileSync('git', ['worktree', 'remove', '--force', dir], { stdio: 'ignore' }); } catch { /* already gone */ } };
  try {
    await symlink(path.resolve('node_modules'), path.join(dir, 'node_modules'));
    execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, stdio: 'inherit' });
    return { buildDir: path.join(dir, 'build'), commit: execFileSync('git', ['rev-parse', '--short', ref]).toString().trim(), cleanup };
  } catch (error) { cleanup(); throw error; }
}
