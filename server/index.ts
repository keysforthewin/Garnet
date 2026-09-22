import express from 'express';
import compression from 'compression';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { WebSocketServer } from 'ws';
import { Hocuspocus } from '@hocuspocus/server';
import { MongoClient } from 'mongodb';
import { mkdir, writeFile, rename, unlink, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON, updateYFragment, initProseMirrorDoc } from '@tiptap/y-tiptap';
import { schema, parseMarkdown, serializeMarkdown, filename } from '../shared/editor.js';
import { defaults, type Settings } from '../shared/types.js';
import { persistenceSignature } from '../shared/sync.js';
import { hashPassword, verifyPassword, hashToken, token, cookieValue, validatePassword } from './auth.js';

function arg(name: string, fallback: string) { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; }
const storage = path.resolve(arg('storage', '/documents'));
const runtime = path.resolve(arg('runtime', '/runtime'));
const publicDir = path.resolve(arg('public', new URL('./public', import.meta.url).pathname));
const mongo = new MongoClient(arg('mongo', 'mongodb://mongo:27017/ed'), { serverSelectionTimeoutMS: 3000 });
await mongo.connect();
const db = mongo.db();
const docs = db.collection<any>('documents');
const users = db.collection<any>('users');
const sessions = db.collection<any>('sessions');
const settingsCollection = db.collection<any>('settings');
const histories = db.collection<any>('revisions');
const preferences = db.collection<any>('preferences');
const jobs = db.collection<any>('jobs');
const conversations = db.collection<any>('conversations');
await Promise.all([
  users.createIndex({ username: 1 }, { unique: true }), sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 }),
  histories.createIndex({ docId: 1, createdAt: -1 }), docs.createIndex({ updatedAt: 1 }),
]);
await users.updateOne({ _id: 'bootstrap-admin' }, { $setOnInsert: { username: 'admin', password: await hashPassword('password'), admin: true, mustChangePassword: true } }, { upsert: true });
await settingsCollection.updateOne({ _id: 'app' }, { $setOnInsert: { value: defaults } }, { upsert: true });
let settings: Settings = (await settingsCollection.findOne({ _id: 'app' }))!.value;
await Promise.all([mkdir(storage, { recursive: true }), mkdir(runtime, { recursive: true }), mkdir(path.join(storage, '.trash'), { recursive: true })]);
await jobs.updateMany({ status: { $in: ['running', 'queued'] } }, { $set: { status: 'interrupted', error: 'App restarted. Review completed actions before retrying.' } });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(compression());
app.use(express.json({ limit: '12mb' }));
const server = createServer(app);
const subscribers = new Set<express.Response>();
function broadcast(type: string, value: any) { const event = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; for (const res of subscribers) { res.write(event); (res as any).flush?.(); } }
const publicUser = (user: any) => ({ id: user._id, username: user.username, admin: user.admin, mustChangePassword: user.mustChangePassword });
const meta = (d: any) => ({ id: d._id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, deletedAt: d.deletedAt, revision: d.revision, mirrorRevision: d.mirrorRevision, filename: d.filename, purgedAt: d.purgedAt });
const bytes = (v: any): Uint8Array => v instanceof Uint8Array ? v : new Uint8Array(v?.buffer || []);
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function validId(id: unknown): asserts id is string { if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail(400, 'Invalid document ID.'); }
function titleValue(value: unknown) { if (typeof value !== 'string' || value.length > 200) fail(400, 'Title must be at most 200 characters.'); return value.trim() || 'Untitled'; }
function docMarkdown(doc: Y.Doc) { return serializeMarkdown(yDocToProsemirrorJSON(doc, 'default')); }
function contentVersion(doc: Y.Doc) { return hashToken(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')); }
const serial = new Map<string, Promise<any>>();
async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = serial.get(id) || Promise.resolve();
  const task = prev.catch(() => {}).then(fn); serial.set(id, task);
  try { return await task; } finally { if (serial.get(id) === task) serial.delete(id); }
}
async function sessionUser(raw: string | undefined) {
  if (!raw) return null;
  const session = await sessions.findOne({ _id: hashToken(raw), expires: { $gt: new Date() } });
  if (!session) return null;
  const user = await users.findOne({ _id: session.userId });
  return user ? { user, session } : null;
}
function sameOrigin(req: express.Request) {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) return res.status(403).json({ error: 'Origin rejected.' });
  next();
});
app.get('/api/health', async (_req, res) => { await db.command({ ping: 1 }); res.json({ ok: true }); });
const attempts = new Map<string, { count: number; until: number }>();
app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'local'; const limit = attempts.get(ip);
  if (limit && limit.until > Date.now() && limit.count >= 10) fail(429, 'Too many login attempts. Try again in 15 minutes.');
  const username = typeof req.body.username === 'string' ? req.body.username : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = await users.findOne({ username });
  if (password.length > 256 || !user || !await verifyPassword(password, user.password)) {
    attempts.set(ip, { count: limit && limit.until > Date.now() ? limit.count + 1 : 1, until: Date.now() + 900000 });
    fail(401, 'Incorrect username or password.');
  }
  attempts.delete(ip); const raw = token(); const csrf = token();
  await sessions.insertOne({ _id: hashToken(raw), userId: user._id, csrf, expires: new Date(Date.now() + 30 * 86400000) });
  res.cookie('ed_session', raw, { httpOnly: true, secure: req.secure, sameSite: 'strict', maxAge: 30 * 86400000, path: '/' });
  res.json({ user: publicUser(user), csrf });
});
app.use('/api', async (req, res, next) => {
  const auth = await sessionUser(cookieValue(req.headers.cookie, 'ed_session'));
  if (!auth) return res.status(401).json({ error: 'Sign in to continue.' });
  res.locals.user = auth.user;
  res.locals.session = auth.session;
  if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== auth.session.csrf) return res.status(403).json({ error: 'Session verification failed. Reload and try again.' });
  if (auth.user.mustChangePassword && !['/me', '/password', '/logout'].includes(req.path)) return res.status(403).json({ error: 'Change your initial password first.' });
  next();
});
app.get('/api/me', (_req, res) => res.json({ user: publicUser(res.locals.user), csrf: res.locals.session.csrf }));
function closeSessionConnections(sessionId: string) {
  for (const document of collab.documents.values()) for (const connection of document.getConnections()) if (connection.context?.sessionId === sessionId) connection.close();
  for (const response of subscribers) if (response.locals.session?._id === sessionId) response.end();
}
app.post('/api/logout', async (_req, res) => { await sessions.deleteOne({ _id: res.locals.session._id }); closeSessionConnections(res.locals.session._id); res.clearCookie('ed_session'); res.json({ ok: true }); });
app.post('/api/password', async (req, res) => {
  validatePassword(req.body.password);
  if (!await verifyPassword(String(req.body.current || ''), res.locals.user.password)) fail(400, 'Current password is incorrect.');
  await users.updateOne({ _id: res.locals.user._id }, { $set: { password: await hashPassword(req.body.password), mustChangePassword: false } });
  const revoked = await sessions.find({ userId: res.locals.user._id, _id: { $ne: res.locals.session._id } }).toArray();
  await sessions.deleteMany({ userId: res.locals.user._id, _id: { $ne: res.locals.session._id } });
  for (const session of revoked) closeSessionConnections(session._id);
  res.json({ ok: true });
});
app.get('/api/users', async (_req, res) => res.json((await users.find().toArray()).map(publicUser)));
app.post('/api/users', async (req, res) => {
  if (!res.locals.user.admin) fail(403, 'Only admins can create accounts.');
  if (typeof req.body.username !== 'string' || !/^[a-zA-Z0-9_.-]{1,40}$/.test(req.body.username)) fail(400, 'Use a username with letters, numbers, dots, dashes, or underscores.');
  validatePassword(req.body.password);
  const user = { _id: randomUUID(), username: req.body.username, password: await hashPassword(req.body.password), admin: req.body.admin === true, mustChangePassword: true };
  await users.insertOne(user); res.status(201).json(publicUser(user));
});

async function revision(id: string, markdown: string, reason: string) {
  await histories.insertOne({ _id: randomUUID(), docId: id, markdown, reason, createdAt: Date.now() });
  const overflow = await histories.find({ docId: id }).sort({ createdAt: -1 }).skip(settings.revisionLimit).project({ _id: 1 }).toArray();
  if (overflow.length) await histories.deleteMany({ _id: { $in: overflow.map(r => r._id) } });
}
async function mirror(id: string) {
  return locked(`mirror:${id}`, async () => {
    const d = await docs.findOne({ _id: id }); if (!d || d.purgedAt) return;
    const name = filename(d.title, id); const relative = d.deletedAt ? `.trash/${name}` : name;
    const target = path.join(storage, relative); const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, d.markdown || '', { mode: 0o600 }); await rename(temp, target);
    if (d.filename && d.filename !== relative) await unlink(path.join(storage, d.filename)).catch(() => {});
    await docs.updateOne({ _id: id, revision: d.revision, title: d.title, deletedAt: d.deletedAt }, { $set: { filename: relative, mirrorRevision: d.revision } });
    broadcast('mirror', { id, revision: d.revision });
  });
}
function queueMirror(id: string) { mirror(id).catch(error => { console.error('Mirror:', error.message); broadcast('mirror-error', { id, error: 'Markdown mirror unavailable; server copy is retained.' }); }); }
async function saveDoc(id: string, document: Y.Doc) {
  return locked(id, async () => {
    const existing = await docs.findOne({ _id: id }); if (!existing) return;
    const state = Buffer.from(Y.encodeStateAsUpdate(document));
    const text = docMarkdown(document); const vector = Buffer.from(Y.encodeStateVector(document)).toString('base64');
    if (!Buffer.from(bytes(existing.state)).equals(state)) {
      if (existing.markdown !== text) await revision(id, existing.markdown || '', 'autosave');
      const updated = await docs.findOneAndUpdate({ _id: id }, { $set: { state, markdown: text, updatedAt: Date.now() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
      broadcast('document', meta(updated)); queueMirror(id);
    }
    (document as any).broadcastStateless?.(JSON.stringify({ type: 'persisted', vector, stateHash: hashToken(persistenceSignature(state)) }));
    return vector;
  });
}
const collab = new Hocuspocus({
  debounce: settings.idleMs, maxDebounce: settings.maxSaveMs, unloadImmediately: false,
  async onAuthenticate({ token: csrf, requestHeaders, documentName }) {
    const auth = await sessionUser(cookieValue(requestHeaders.get('cookie') || undefined, 'ed_session'));
    if (!auth || auth.user.mustChangePassword || auth.session.csrf !== csrf) throw new Error('Authentication required');
    const doc = await docs.findOne({ _id: documentName, deletedAt: null }); if (!doc) throw new Error('Document unavailable');
    return { userId: auth.user._id, sessionId: auth.session._id };
  },
  async beforeHandleMessage({ context, documentName }) {
    if (context?.internal) return;
    const session = await sessions.findOne({ _id: context.sessionId, expires: { $gt: new Date() } });
    if (!session || !await docs.findOne({ _id: documentName, deletedAt: null })) throw new Error('Session or document unavailable');
  },
  async onLoadDocument({ documentName, document }) {
    const record = await docs.findOne({ _id: documentName });
    if (!record) throw new Error('Document unavailable');
    if (record.state) Y.applyUpdate(document, bytes(record.state));
    return document;
  },
  async onStoreDocument({ documentName, document }) { await saveDoc(documentName, document); },
  async onStateless({ document, payload }) { if (payload === 'flush') await saveDoc(document.name, document); },
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url?.split('?')[0] !== '/collaboration' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, String(value));
    const connection = collab.handleConnection(ws, new Request(`http://${req.headers.host}${req.url}`, { headers }));
    ws.on('message', data => connection.handleMessage(new Uint8Array(Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? data : Buffer.concat(data))));
    ws.on('close', (code, reason) => connection.handleClose({ code, reason: reason.toString() }));
    ws.on('error', () => connection.handleClose());
  });
});
app.get('/api/events', (_req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
  subscribers.add(res); res.write(': connected\n\n');
  const ping = setInterval(() => { if (new Date(res.locals.session.expires).getTime() <= Date.now()) res.end(); else { res.write(': heartbeat\n\n'); (res as any).flush?.(); } }, 15000);
  res.on('close', () => { subscribers.delete(res); clearInterval(ping); });
});
app.get('/api/documents', async (_req, res) => res.json((await docs.find({}, { projection: { state: 0, markdown: 0, ops: 0 } }).toArray()).map(meta)));
app.post('/api/documents', async (req, res) => {
  validId(req.body.id); const title = titleValue(req.body.title || 'Untitled');
  const empty = new Y.Doc(); const state = Buffer.from(Y.encodeStateAsUpdate(empty)); empty.destroy();
  await docs.updateOne({ _id: req.body.id }, { $setOnInsert: { title, state, markdown: '', revision: 0, mirrorRevision: -1, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null, ops: [] } }, { upsert: true });
  const d = await docs.findOne({ _id: req.body.id }); broadcast('document', meta(d)); queueMirror(d._id); res.json(meta(d));
});
app.patch('/api/documents/:id', async (req, res) => {
  const id = String(req.params.id); validId(id); validId(req.body.opId);
  const d = await locked(id, async () => {
    const d = await docs.findOne({ _id: id }); if (!d) fail(404, 'Document not found.');
    if (d.ops.includes(req.body.opId)) return d;
    if (d.purgedAt) fail(410, 'This document has passed its trash retention period.');
    const change: any = { updatedAt: Date.now() };
    if ('title' in req.body) change.title = titleValue(req.body.title);
    if ('deleted' in req.body) {
      if (typeof req.body.deleted !== 'boolean') fail(400, 'Invalid deletion operation.');
      change.deletedAt = req.body.deleted ? Date.now() : null;
    }
    return docs.findOneAndUpdate({ _id: id }, { $set: change, $push: { ops: req.body.opId }, $inc: { revision: 1 } }, { returnDocument: 'after' });
  });
  if (d.deletedAt) collab.closeConnections(id);
  broadcast('document', meta(d)); queueMirror(id); res.json(meta(d));
});
app.get('/api/documents/:id/state', async (req, res) => {
  const d = await docs.findOne({ _id: req.params.id }); if (!d) fail(404, 'Document not found.');
  res.json({ ...meta(d), state: Buffer.from(bytes(d.state)).toString('base64'), markdown: d.markdown });
});
app.get('/api/documents/:id/revisions', async (req, res) => res.json(await histories.find({ docId: req.params.id }).sort({ createdAt: -1 }).toArray()));
async function changeMarkdown(id: string, text: string, expected: string | undefined, reason: string) {
  validId(id); if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) fail(400, 'Markdown must be text smaller than 2 MB.');
  const json = parseMarkdown(text); const node = schema.nodeFromJSON(json); node.check();
  const direct = await collab.openDirectConnection(id, { internal: true });
  try {
    const doc = direct.document!;
    const before = docMarkdown(doc);
    await revision(id, before, reason);
    await direct.transact(doc => {
      if (expected && expected !== contentVersion(doc)) fail(409, 'Document changed. Read its current contents and retry.');
      const fragment = doc.getXmlFragment('default'); const { mapping } = initProseMirrorDoc(fragment, schema);
      updateYFragment(doc, fragment, node, { mapping, isOMark: new Map() });
    });
    await saveDoc(id, doc);
    return { id, version: contentVersion(doc), markdown: docMarkdown(doc) };
  } finally { await direct.disconnect(); }
}
app.post('/api/documents/:id/restore', async (req, res) => {
  const r = await histories.findOne({ _id: req.body.revisionId, docId: req.params.id }); if (!r) fail(404, 'Revision not found.');
  if (typeof req.body.version !== 'string') fail(400, 'A current content version is required.');
  res.json(await changeMarkdown(String(req.params.id), r.markdown, req.body.version, 'before restore'));
});
app.get('/api/documents/:id/content', async (req, res) => {
  const direct = await collab.openDirectConnection(String(req.params.id), { internal: true });
  try { res.json({ markdown: docMarkdown(direct.document!), version: contentVersion(direct.document!) }); } finally { await direct.disconnect(); }
});
app.post('/api/documents/:id/import', async (req, res) => {
  const d = await docs.findOne({ _id: req.params.id }); if (!d) fail(404, 'Document not found.');
  if (d.markdown) fail(409, 'Import into a new document.');
  const result = await changeMarkdown(String(req.params.id), req.body.markdown, undefined, 'import');
  await db.collection<any>('imports').updateOne({ _id: req.params.id }, { $set: { original: req.body.markdown } }, { upsert: true });
  res.json(result);
});
app.get('/api/preferences', async (_req, res) => res.json((await preferences.findOne({ _id: res.locals.user._id }))?.value || {}));
app.patch('/api/preferences', async (req, res) => {
  if (JSON.stringify(req.body).length > 1000000) fail(400, 'Preferences are too large.');
  const entries = Object.entries(req.body);
  if (entries.some(([key]) => !/^[a-zA-Z0-9_-]{1,120}$/.test(key))) fail(400, 'Invalid preference key.');
  await preferences.updateOne({ _id: res.locals.user._id }, { $set: Object.fromEntries(entries.map(([k, v]) => [`value.${k}`, v])) }, { upsert: true });
  res.json({ ok: true });
});
app.get('/api/settings', (_req, res) => res.json(settings));
app.put('/api/settings', async (req, res) => {
  const next: Settings = req.body;
  if (!Number.isInteger(next.idleMs) || next.idleMs < 100 || next.idleMs > 10000 || !Number.isInteger(next.maxSaveMs) || next.maxSaveMs < next.idleMs || next.maxSaveMs > 30000) fail(400, 'Invalid autosave timing.');
  if (!Number.isInteger(next.revisionLimit) || next.revisionLimit < 1 || next.revisionLimit > 1000 || !Number.isInteger(next.trashDays) || next.trashDays < 1 || next.trashDays > 3650) fail(400, 'Invalid retention setting.');
  if (!next.agent || !['claude', 'codex'].includes(next.agent.provider) || !Number.isInteger(next.agent.timeoutMinutes) || next.agent.timeoutMinutes < 1 || next.agent.timeoutMinutes > 240) fail(400, 'Invalid agent settings.');
  for (const key of ['claudePath', 'codexPath', 'cwd', 'model'] as const) if (typeof next.agent[key] !== 'string' || next.agent[key].length > 1024 || next.agent[key].includes('\0')) fail(400, 'Invalid agent configuration.');
  if (typeof next.httpsAddress !== 'string' || (next.httpsAddress && !/^[a-zA-Z0-9.:-]+$/.test(next.httpsAddress))) fail(400, 'Enter a hostname or IP address without a URL scheme.');
  settings = { idleMs: next.idleMs, maxSaveMs: next.maxSaveMs, trashDays: next.trashDays, revisionLimit: next.revisionLimit, httpsAddress: next.httpsAddress, agent: next.agent };
  await settingsCollection.updateOne({ _id: 'app' }, { $set: { value: settings } });
  collab.configure({ debounce: settings.idleMs, maxDebounce: settings.maxSaveMs });
  await configureHttps(); res.json(settings);
});
async function configureHttps() {
  const host = settings.httpsAddress || 'localhost';
  const config = `${host} {\n tls internal\n reverse_proxy app:7777\n}\n:8082 {\n root * /data/caddy/pki/authorities/local\n rewrite * /root.crt\n file_server\n}\n`;
  await writeFile(path.join(runtime, 'Caddyfile'), config);
  // The Caddy service watches its generated configuration with --watch.
}
await configureHttps();
app.get('/api/certificate', async (_req, res) => {
  const pem = await fetch('http://https:8082/root.crt').then(async r => r.ok ? Buffer.from(await r.arrayBuffer()) : null).catch(() => null);
  if (!pem) fail(503, 'Certificate is not ready. Start the HTTPS service first.');
  res.setHeader('Content-Disposition', 'attachment; filename="garnet-local-ca.crt"'); res.type('application/x-x509-ca-cert').send(pem);
});

function runnerRequest(route: string, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: path.join(runtime, 'runner.sock'), path: route, method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, timeout: 5000 }, res => {
      let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => { try { const result = JSON.parse(raw); res.statusCode! >= 400 ? reject(new Error(result.error)) : resolve(result); } catch { reject(new Error('Invalid runner response')); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Host runner timed out'))); req.end(body ? JSON.stringify(body) : undefined);
  });
}
app.get('/api/runner', async (_req, res) => { try { res.json(await runnerRequest('/health')); } catch { res.json({ ok: false, error: 'Host runner is not connected.' }); } });
app.get('/api/conversations', async (_req, res) => res.json(await conversations.find().sort({ updatedAt: -1 }).limit(100).toArray()));
app.get('/api/conversations/:id/jobs', async (req, res) => res.json(await jobs.find({ conversationId: req.params.id }, { projection: { tokenHash: 0 } }).sort({ createdAt: 1 }).toArray()));
app.post('/api/jobs', async (req, res) => {
  if (typeof req.body.prompt !== 'string' || !req.body.prompt.trim() || req.body.prompt.length > 50000) fail(400, 'Enter a prompt up to 50,000 characters.');
  const conversationId = req.body.conversationId || randomUUID(); validId(conversationId);
  await locked(`conversation:${conversationId}`, async () => {
    if (await jobs.findOne({ conversationId, status: { $in: ['running', 'queued'] } })) fail(409, 'This conversation is still running.');
    const conversation = await conversations.findOne({ _id: conversationId });
    const provider = conversation?.provider || req.body.provider || settings.agent.provider;
    if (!['claude', 'codex'].includes(provider)) fail(400, 'Unknown provider.');
    const id = randomUUID(); const secret = token();
    const job = { _id: id, conversationId, provider, prompt: req.body.prompt, docId: req.body.docId || null, status: 'queued', events: [], createdAt: Date.now(), userId: res.locals.user._id, tokenHash: hashToken(secret) };
    await jobs.insertOne(job);
    await conversations.updateOne({ _id: conversationId }, { $set: { provider, updatedAt: Date.now() }, $setOnInsert: { title: req.body.prompt.slice(0, 70) } }, { upsert: true });
    try {
      await runnerRequest('/run', { id, conversationId, provider, prompt: job.prompt, docId: job.docId, sessionId: conversation?.sessionId, secret, settings: settings.agent });
      await jobs.updateOne({ _id: id, status: 'queued' }, { $set: { status: 'running' } });
    } catch (error: any) { await jobs.updateOne({ _id: id }, { $set: { status: 'failed', error: error.message } }); }
    res.status(202).json({ id, conversationId });
  });
});
app.post('/api/jobs/:id/cancel', async (req, res) => { await runnerRequest('/cancel', { id: req.params.id }); res.json({ ok: true }); });

// Runner callbacks/tools use a private Unix socket, never a public unauthenticated route.
const internal = express(); internal.use(express.json({ limit: '12mb' }));
internal.use(async (req, res, next) => {
  const raw = req.headers.authorization?.replace(/^Bearer /, '');
  const job = raw && await jobs.findOne({ tokenHash: hashToken(raw), status: { $in: ['running', 'queued'] } });
  if (!job) return res.status(401).json({ error: 'Job is not active.' });
  res.locals.job = job; next();
});
internal.post('/event', async (req, res) => {
  const job = res.locals.job; const event = req.body;
  if (event.type === 'heartbeat') { await jobs.updateOne({ _id: job._id }, { $set: { heartbeatAt: Date.now() } }); res.json({ ok: true }); return; }
  if (JSON.stringify(event).length > 100000) fail(400, 'Agent event too large.');
  if (event.type === 'text' && typeof event.text === 'string') await jobs.updateOne({ _id: job._id }, [{ $set: { output: { $concat: [{ $ifNull: ['$output', ''] }, { $literal: event.text }] } } }]);
  await jobs.updateOne({ _id: job._id }, { $push: { events: { $each: [event], $slice: -2000 } } } as any);
  if (event.sessionId) await conversations.updateOne({ _id: job.conversationId }, { $set: { sessionId: event.sessionId } });
  if (event.type === 'done') await jobs.updateOne({ _id: job._id }, { $set: { status: event.status, error: event.error || null, finishedAt: Date.now() }, $unset: { tokenHash: '' } });
  broadcast('agent', { jobId: job._id, conversationId: job.conversationId, ...event }); res.json({ ok: true });
});
internal.post('/tool', async (req, res) => {
  const { name, arguments: args = {} } = req.body;
  if (name === 'list_documents' || name === 'search_documents') {
    const all = await docs.find({ deletedAt: null }, { projection: { state: 0, ops: 0 } }).toArray();
    const query = String(args.query || '').toLowerCase();
    return res.json(all.filter(d => !query || `${d.title}\n${d.markdown}`.toLowerCase().includes(query)).map(d => ({ ...meta(d), excerpt: d.markdown.slice(0, 300) })));
  }
  if (name === 'create_document') {
    const id = randomUUID(); const empty = new Y.Doc();
    await docs.insertOne({ _id: id, title: titleValue(args.title || 'Untitled'), state: Buffer.from(Y.encodeStateAsUpdate(empty)), markdown: '', revision: 0, mirrorRevision: -1, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null, ops: [] }); empty.destroy();
    if (args.markdown) await changeMarkdown(id, args.markdown, undefined, 'agent create');
    const d = await docs.findOne({ _id: id }); broadcast('document', meta(d)); queueMirror(id); return res.json(meta(d));
  }
  validId(args.id);
  const record = await docs.findOne({ _id: args.id, deletedAt: null }); if (!record) fail(404, 'Document not found.');
  if (name === 'read_document') {
    const direct = await collab.openDirectConnection(args.id, { internal: true });
    try { return res.json({ ...meta(record), markdown: docMarkdown(direct.document!), version: contentVersion(direct.document!) }); } finally { await direct.disconnect(); }
  }
  if (name === 'edit_document') {
    if (typeof args.version !== 'string') fail(400, 'Read the document first and supply its version.');
    const direct = await collab.openDirectConnection(args.id, { internal: true });
    let current: string;
    try {
      if (contentVersion(direct.document!) !== args.version) fail(409, 'Document changed. Read and retry.');
      current = docMarkdown(direct.document!);
    } finally { await direct.disconnect(); }
    let next = args.markdown;
    if (args.find !== undefined) {
      if (typeof args.find !== 'string' || !args.find || typeof args.replace !== 'string' || current.split(args.find).length !== 2) fail(409, 'Find text must match exactly once. Read and retry.');
      next = current.replace(args.find, () => args.replace);
    }
    return res.json(await changeMarkdown(args.id, next, args.version, 'before agent edit'));
  }
  fail(400, 'Unknown document tool.');
});
const errorHandler: express.ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err.code === 11000 ? 409 : err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.code === 11000 ? 'That name is already in use.' : status >= 500 ? 'Service unavailable. Your local edits are retained.' : err.message });
};
internal.use(errorHandler);
await unlink(path.join(runtime, 'app.sock')).catch(() => {});
const internalServer = internal.listen(path.join(runtime, 'app.sock'), () => void chmod(path.join(runtime, 'app.sock'), 0o600));
app.use('/assets', express.static(path.join(publicDir, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(publicDir, { maxAge: 0 }));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.use(errorHandler);
const maintenance = setInterval(async () => {
  try {
    await jobs.updateMany({ status: 'running', createdAt: { $lt: Date.now() - 120000 }, $or: [{ heartbeatAt: { $lt: Date.now() - 120000 } }, { heartbeatAt: { $exists: false } }] }, { $set: { status: 'interrupted', error: 'Runner stopped responding. Review completed actions before retrying.' }, $unset: { tokenHash: '' } });
    for (const d of await docs.find().toArray()) {
      if (d.mirrorRevision !== d.revision) queueMirror(d._id);
      if (d.deletedAt && !d.purgedAt && d.deletedAt < Date.now() - settings.trashDays * 86400000) {
        // Keep the tombstone so offline devices cannot resurrect a deleted document.
        if (d.filename) await unlink(path.join(storage, d.filename)).catch(() => {});
        await histories.deleteMany({ docId: d._id });
        await docs.updateOne({ _id: d._id, deletedAt: d.deletedAt }, { $set: { purgedAt: Date.now(), markdown: '', state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), mirrorRevision: d.revision }, $unset: { filename: '' } });
      }
    }
    for (const doc of collab.documents.values()) await saveDoc(doc.name, doc).catch(() => {});
  } catch (error: any) { console.error('Maintenance:', error.message); }
}, 30000);
for (const d of await docs.find().toArray()) queueMirror(d._id);
server.listen(Number(arg('port', '7777')), '0.0.0.0', () => console.log(`Garnet listening on ${arg('port', '7777')}`));
async function shutdown() { clearInterval(maintenance); server.close(); for (const doc of collab.documents.values()) await saveDoc(doc.name, doc); for (const res of subscribers) res.end(); collab.closeConnections(); await Promise.allSettled([...serial.values()]); internalServer.close(); await mongo.close(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
