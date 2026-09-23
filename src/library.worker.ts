import * as Y from 'yjs';
import { yDocToProsemirrorJSON, updateYFragment, initProseMirrorDoc } from '@tiptap/y-tiptap';
import { schema, parseMarkdown, serializeMarkdown } from '../shared/markdown';
import { b64, unb64 } from './base64';

// Keeps the search index and the offline copies of open documents, so encoding
// documents and converting them to Markdown never runs on the page's main thread.

// Lowercased titles and text, kept separately. Terms never contain whitespace,
// so matching either field is the same as matching "title\ntext".
const titles = new Map<string, string>(); const texts = new Map<string, string>();
let database = ''; let library: Promise<IDBDatabase> | undefined;
// The page creates and upgrades databases. Opening one that does not exist would
// create it empty, and a signed-out account's databases must stay deleted.
function openExisting(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.transaction!.abort();
    // Never hold up an upgrade, or the deletion of a signed-out account's databases.
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
  });
}
function openLibrary() {
  return library ??= openExisting(database).then(db => { db.onversionchange = () => { db.close(); library = undefined; }; return db; }, error => { library = undefined; throw error; });
}
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const toMarkdown = (doc: Y.Doc) => serializeMarkdown(yDocToProsemirrorJSON(doc, 'default'));
async function store(id: string, doc: Y.Doc) {
  const markdown = toMarkdown(doc);
  const tx = (await openLibrary()).transaction('content', 'readwrite');
  tx.objectStore('content').put({ id, state: b64(Y.encodeStateAsUpdate(doc)), markdown }, id);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local storage write aborted')); });
  texts.set(id, markdown.toLowerCase());
}
// Builds a document that exists only here (an import or a merge) and stores it.
async function storeNew(id: string, fill: (doc: Y.Doc) => void | Promise<void>) {
  const doc = new Y.Doc();
  try { await fill(doc); await store(id, doc); } finally { doc.destroy(); }
}

// A copy of each open document, fed the page's Yjs updates. Work for one
// document runs in the order its messages arrived, after the copy has loaded.
interface Mirror { doc: Y.Doc; loaded: Promise<void>; queue: Promise<unknown>; changed: boolean }
const mirrors = new Map<string, Mirror>();
function open(id: string) {
  if (mirrors.has(id)) return;
  const doc = new Y.Doc();
  // The same state the page loaded: the last snapshot plus y-indexeddb's updates since.
  const loaded = (async () => {
    const saved = await result((await openLibrary()).transaction('content').objectStore('content').get(id));
    const updates = await openExisting(`${database}:doc:${id}`).then(db => result<Uint8Array[]>(db.transaction('updates').objectStore('updates').getAll()).finally(() => db.close()));
    if (saved?.state) Y.applyUpdate(doc, unb64(saved.state));
    for (const update of updates) Y.applyUpdate(doc, update);
  })();
  loaded.catch(() => {});
  // Like the page, take a fresh snapshot after opening: updates may have arrived since the last one.
  mirrors.set(id, { doc, loaded, queue: Promise.resolve(), changed: true });
}
function queue<T>(mirror: Mirror, work: () => T | Promise<T>): Promise<T> {
  const next = mirror.queue.then(() => mirror.loaded).then(work); mirror.queue = next.catch(() => {}); return next;
}
async function save(id: string, mirror: Mirror) {
  if (!mirror.changed) return false;
  mirror.changed = false;
  try { await store(id, mirror.doc); } catch (error) { mirror.changed = true; throw error; }
  return true;
}
const reply = (request: number, work: Promise<unknown>) => work.then(
  value => self.postMessage({ type: 'reply', request, value }),
  error => self.postMessage({ type: 'reply', request, error: error?.message || String(error) }),
);

self.onmessage = ({ data }) => {
  if (data.type === 'index') for (const d of data.docs) { titles.set(d.id, d.title.toLowerCase()); if (d.markdown !== undefined) texts.set(d.id, d.markdown.toLowerCase()); }
  // Reads every document's Markdown here rather than on the page's main thread.
  // Text indexed since the page started is newer, so it wins.
  if (data.type === 'load') {
    database = data.database;
    openLibrary().then(db => result(db.transaction('content').objectStore('content').getAll())).then(all => { for (const c of all) if (!texts.has(c.id)) texts.set(c.id, (c.markdown || '').toLowerCase()); }, () => {});
  }
  if (data.type === 'search') {
    const q = data.query.toLowerCase().trim(); const terms: string[] = q.split(/\s+/);
    const ids = [...titles].filter(([id, title]) => { const text = texts.get(id) || ''; return terms.every(term => title.includes(term) || text.includes(term)); })
      .sort((a, b) => Number(b[1].includes(q)) - Number(a[1].includes(q))).map(([id]) => id);
    self.postMessage({ type: 'results', query: data.query, ids });
  }
  const mirror = mirrors.get(data.id);
  if (data.type === 'open') open(data.id);
  if (data.type === 'update' && mirror) queue(mirror, () => { Y.applyUpdate(mirror.doc, data.update); mirror.changed = true; }).catch(() => {});
  if (data.type === 'close' && mirror) { mirrors.delete(data.id); queue(mirror, () => mirror.doc.destroy()).catch(() => mirror.doc.destroy()); }
  // Stores a snapshot if the document changed since the last one, and replies whether it did.
  if (data.type === 'save') reply(data.request, mirror ? queue(mirror, () => save(data.id, mirror)) : Promise.resolve(false));
  if (data.type === 'markdown') reply(data.request, mirror ? queue(mirror, () => toMarkdown(mirror.doc)) : Promise.reject(new Error('Document is not open.')));
  if (data.type === 'import') reply(data.request, storeNew(data.id, doc => {
    const fragment = doc.getXmlFragment('default');
    updateYFragment(doc, fragment, schema.nodeFromJSON(parseMarkdown(data.markdown)), { mapping: initProseMirrorDoc(fragment, schema).mapping, isOMark: new Map() });
  }));
  // Pending local edits to a closed document, merged with the server's state.
  if (data.type === 'merge') reply(data.request, storeNew(data.id, async doc => {
    const local = await result((await openLibrary()).transaction('content').objectStore('content').get(data.id));
    if (local?.state) Y.applyUpdate(doc, unb64(local.state));
    Y.applyUpdate(doc, unb64(data.state));
  }));
};
