import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
test('retries server and mirror failures, rejects stale restore, and deduplicates actions', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click(); await page.getByLabel('Document title').fill('Recovery check'); await page.locator('.prose').click(); await page.keyboard.type('Before outage.'); await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  const id = new URL(page.url()).hash.slice(1);
  const api = async (url: string, method = 'GET', body?: any) => page.evaluate(async ({ url, method, body }) => { const me = await fetch('/api/me').then(r => r.json()); const result = await fetch(`/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: result.status, data: await result.json() }; }, { url, method, body });
  const version = (await api(`/documents/${id}/content`)).data.version;
  execFileSync(process.execPath, ['scripts/test-app.mjs', 'stop']);
  await page.locator('.prose').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' During outage.'); await expect(page.locator('#main')).toHaveAttribute('data-save-state', /offline|syncing/);
  const reconnected = page.waitForResponse(response => response.url().endsWith('/api/events') && response.ok());
  execFileSync(process.execPath, ['scripts/test-app.mjs', 'start']);
  await reconnected;
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved', { timeout: 45000 });
  expect((await api(`/documents/${id}/state`)).data.markdown).toContain('During outage.');
  const revisions = (await api(`/documents/${id}/revisions`)).data;
  expect((await api(`/documents/${id}/restore`, 'POST', { revisionId: revisions[0]._id, version })).status).toBe(409);
  const opId = crypto.randomUUID(); const first = await api(`/documents/${id}`, 'PATCH', { title: 'Recovery check', opId }); const second = await api(`/documents/${id}`, 'PATCH', { title: 'Recovery check', opId }); expect(second.data.revision).toBe(first.data.revision);
  try {
    await chmod('data/test-documents', 0o500);
    await page.locator('.prose').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Mirror recovery.');
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    await expect(page.locator('#toast')).toContainText('Markdown mirror unavailable');
    const current = (await api(`/documents/${id}/state`)).data; expect(current.markdown).toContain('Mirror recovery.'); expect(current.mirrorRevision).toBeLessThan(current.revision);
  } finally { await chmod('data/test-documents', 0o700); }
  await expect.poll(async () => readFile(`data/test-documents/Recovery-check--${id}.md`, 'utf8').catch(() => ''), { timeout: 45000 }).toContain('Mirror recovery.');
  const current = (await api(`/documents/${id}/content`)).data;
  expect((await api(`/documents/${id}/restore`, 'POST', { revisionId: revisions[0]._id, version: current.version })).status).toBe(200);
  await expect(page.locator('.prose')).not.toContainText('Mirror recovery.');
});
test('injected storage quota failure keeps the editor usable and permits in-memory export', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click(); await page.getByLabel('Document title').fill('Quota recovery'); await page.locator('.prose').click(); await page.keyboard.type('This is locally editable.'); await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  await page.evaluate(() => { const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'docs') throw new DOMException('Simulated storage quota exceeded', 'QuotaExceededError'); return original.apply(this, args); }; });
  await page.context().setOffline(true); await page.locator('.prose').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Preserve this in-memory addition.');
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'local-error'); await expect(page.locator('.prose')).toContainText('in-memory addition');
  const downloaded = page.waitForEvent('download'); await page.locator('#menu-button').click(); await page.locator('#export-button').click(); const file = await downloaded; expect(await readFile((await file.path())!, 'utf8')).toContain('Preserve this in-memory addition.');
});
test('a version 1 local cache is upgraded in place and still opens offline', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click(); await page.getByLabel('Document title').fill('Upgrade check'); await page.locator('.prose').click(); await page.keyboard.type('Content from the old cache.');
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved'); await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const id = new URL(page.url()).hash.slice(1);
  // Leave the app so it releases its databases, then rewrite the cache in the version 1 layout (content inside each
  // 'docs' record) and drop the document's y-indexeddb copy, so its text can only come from the migrated snapshot.
  await page.goto('/api/health');
  await page.evaluate(async id => {
    const user = JSON.parse(localStorage.getItem('ed-user')!); const name = `ed:${user.id}`;
    const done = (request: IDBRequest | IDBTransaction) => new Promise<any>((resolve, reject) => { if (request instanceof IDBTransaction) { request.oncomplete = () => resolve(undefined); request.onerror = () => reject(request.error); } else { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); } });
    const open = (version?: number) => { const request = version ? indexedDB.open(name, version) : indexedDB.open(name); request.onupgradeneeded = () => { for (const store of ['docs', 'ops', 'prefs']) request.result.createObjectStore(store); }; return done(request) as Promise<IDBDatabase>; };
    const entries = async (db: IDBDatabase, store: string) => { const tx = db.transaction(store); const [keys, values] = await Promise.all([done(tx.objectStore(store).getAllKeys()), done(tx.objectStore(store).getAll())]); return keys.map((key: string, i: number) => [key, values[i]]); };
    const current = await open(); const content = new Map((await entries(current, 'content')).map(([key, value]: any) => [key, value]));
    const stores = Object.fromEntries(await Promise.all(['docs', 'ops', 'prefs'].map(async store => [store, await entries(current, store)])));
    current.close(); await done(indexedDB.deleteDatabase(name)); await done(indexedDB.deleteDatabase(`${name}:doc:${id}`));
    const old = await open(1); const tx = old.transaction(['docs', 'ops', 'prefs'], 'readwrite');
    for (const [key, value] of stores.docs) { const { cached, ...meta } = value; const saved: any = content.get(key); tx.objectStore('docs').put(cached ? { ...meta, state: saved.state, markdown: saved.markdown } : meta, key); }
    for (const store of ['ops', 'prefs']) for (const [key, value] of stores[store]) tx.objectStore(store).put(value, key);
    await done(tx); old.close();
  }, id);
  await page.context().setOffline(true); await page.goto(`/#${id}`);
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Content from the old cache.');
  const layout = await page.evaluate(async id => {
    const user = JSON.parse(localStorage.getItem('ed-user')!); const request = indexedDB.open(`ed:${user.id}`);
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const get = (store: string) => new Promise<any>(resolve => { const r = db.transaction(store).objectStore(store).get(id); r.onsuccess = () => resolve(r.result); });
    const [meta, content] = await Promise.all([get('docs'), get('content')]); db.close();
    return { version: db.version, metaHasState: 'state' in meta, cached: meta.cached, contentHasState: typeof content?.state === 'string' };
  }, id);
  expect(layout).toEqual({ version: 2, metaHasState: false, cached: true, contentHasState: true });
  await page.context().setOffline(false);
});

test('a document the server lost, as in a reinstall, is restored from the devices that have it and shared live again', async ({ browser }) => {
  const signIn = async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.locator('#menu-button')).toBeVisible(); return page;
  };
  const [first, second] = [await signIn(), await signIn()];
  try {
    await first.locator('#menu-button').click(); await first.locator('#new-doc').click(); await first.keyboard.type('Lost with the server');
    await first.locator('.prose').click(); await first.keyboard.type('Written before the loss.'); await expect(first.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    const id = new URL(first.url()).hash.slice(1);
    await second.goto(`/#${id}`); await expect(second.locator('.prose')).toHaveText('Written before the loss.');
    // A reinstall: the server starts again without the document.
    const mongo = await new MongoClient('mongodb://127.0.0.1:27018/ed_test').connect();
    try { await mongo.db().collection('documents').deleteOne({ _id: id as any }); } finally { await mongo.close(); }
    execFileSync(process.execPath, ['scripts/test-app.mjs', 'start']);
    for (const page of [first, second]) await page.reload();
    await expect(first.locator('#toast')).toContainText('restored from this device’s copy');
    await expect.poll(() => first.evaluate(async id => (await fetch('/api/documents').then(r => r.json())).some((d: any) => d.id === id), id)).toBe(true);
    for (const [from, to, text] of [[first, second, ' From the first.'], [second, first, ' From the second.']] as const) {
      await from.locator('.prose').click(); await from.keyboard.press('Control+End'); await from.keyboard.type(text);
      await expect(to.locator('.prose')).toContainText(text.trim());
    }
    // Both copies shared their history, so merging them repeats nothing.
    await expect.poll(() => first.evaluate(async id => (await fetch(`/api/documents/${id}/state`).then(r => r.json())).markdown.trim(), id)).toBe('Written before the loss. From the first. From the second.');
    for (const page of [first, second]) await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  } finally { await first.context().close(); await second.context().close(); }
});
