let database: IDBDatabase;
export async function openCache(userId: string) {
  database?.close();
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(`ed:${userId}`, 1);
    request.onupgradeneeded = () => { for (const name of ['docs', 'ops', 'prefs']) request.result.createObjectStore(name); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
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
