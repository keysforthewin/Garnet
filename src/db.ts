let database: IDBDatabase;
// Version 2 keeps document content (Yjs state and Markdown) in its own store, so
// startup reads only the small metadata records in 'docs'.
export async function openCache(userId: string, events: { blocked: () => void; replaced: () => void }) {
  database?.close();
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`ed:${userId}`, 2);
    request.onupgradeneeded = event => {
      const db = request.result; const transaction = request.transaction!;
      for (const name of ['docs', 'ops', 'prefs', 'content']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      if (event.oldVersion !== 1) return;
      const docs = transaction.objectStore('docs'); const content = transaction.objectStore('content');
      docs.openCursor().onsuccess = e => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result; if (!cursor) return;
        const { state, markdown, ...meta } = cursor.value;
        if (state !== undefined) { content.put({ id: meta.id, state, markdown }, cursor.key); meta.cached = true; }
        cursor.update(meta); cursor.continue();
      };
    };
    // An open tab running an older version holds the database until it closes.
    request.onblocked = events.blocked;
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); events.replaced(); }; resolve(db); };
    request.onerror = () => reject(request.error);
  });
}
export function get<T = any>(store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => { const request = database.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export function all<T = any>(store: string): Promise<T[]> {
  return new Promise((resolve, reject) => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export function put(store: string, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => { const tx = database.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Local storage write aborted')); });
}
export function remove(store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => { const tx = database.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}
export async function clearAccount(userId: string) {
  database.close();
  const databases = await indexedDB.databases();
  await Promise.all(databases.filter(d => d.name === `ed:${userId}` || d.name?.startsWith(`ed:${userId}:doc:`)).map(d => new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(d.name!); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Close other Garnet tabs before clearing this account.')); })));
}
