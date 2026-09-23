import { test, expect, type Page } from '@playwright/test';
const password = 'ed-test-password-2026';
async function login(page: Page) {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#menu-button')).toBeVisible();
}
async function note(page: Page, title: string, text: string) {
  const previous = page.url();
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click(); await expect(page).not.toHaveURL(previous);
  await page.getByLabel('Document title', { exact: true }).fill(title); await page.locator('.prose').click(); await page.keyboard.type(text);
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  return new URL(page.url()).hash.slice(1);
}
async function open(page: Page, title: string) {
  await page.locator('#menu-button').click(); await page.locator('.doc-row').filter({ hasText: title }).click();
  await expect(page.getByLabel('Document title', { exact: true })).toHaveValue(title);
}

test('the workspace opens from the local copy before the session check, and an expired session asks to sign in over it', async ({ browser }) => {
  // Service workers would hide the session check from request interception.
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  try {
    await login(page); const id = await note(page, 'Before the session check', 'Written before a slow session check.');
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/me', async route => { await held; await route.continue(); });
    await page.reload();
    await expect(page.locator('.prose')).toContainText('Written before a slow session check.');
    release();
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');

    await page.evaluate(async () => { const { csrf } = await fetch('/api/me').then(r => r.json()); await fetch('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } }); });
    await page.reload();
    const signIn = page.locator('dialog', { hasText: 'Your local changes are retained.' });
    await expect(signIn).toBeVisible();
    await expect(page.locator('.prose')).toContainText('Written before a slow session check.');
    await signIn.getByLabel('Password', { exact: true }).fill(password); await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(signIn).toBeHidden();
    await page.locator('.prose').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Synced after signing in again.');
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    const state = await page.evaluate(async id => (await fetch(`/api/documents/${id}/state`).then(r => r.json())).markdown, id);
    expect(state).toContain('Synced after signing in again.');
  } finally { await context.close(); }
});

test('a page started as another cached account reloads as the one the server has signed in', async ({ page }) => {
  await login(page);
  await page.evaluate(() => { const user = JSON.parse(localStorage.getItem('ed-user')!); localStorage.setItem('ed-user', JSON.stringify({ ...user, id: 'another-account', username: 'another' })); });
  await page.reload();
  await expect(page.locator('#account-button')).toHaveText('admin');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ed-user')!).username)).toBe('admin');
});

test('returning to a document reuses its editor, which kept a collaborator’s edits and hid this person’s caret', async ({ browser, page }) => {
  await login(page); const id = await note(page, 'Kept editor', 'Kept alive while hidden.');
  const context = await browser.newContext(); const second = await context.newPage();
  try {
    await login(second); await open(second, 'Kept editor');
    await expect(second.locator('.collaboration-carets__caret')).toHaveCount(1);
    await page.locator('.ProseMirror').evaluate(element => { (element as any).kept = true; });
    await note(page, 'Elsewhere', 'Somewhere else.');
    await expect(second.locator('.collaboration-carets__caret')).toHaveCount(0);
    await second.locator('.prose').click(); await second.keyboard.press('Control+End'); await second.keyboard.type(' Added while hidden.');
    await expect.poll(() => page.evaluate(async id => (await fetch(`/api/documents/${id}/state`).then(r => r.json())).markdown, id)).toContain('Added while hidden.');
    await open(page, 'Kept editor');
    await expect(page.locator('.ProseMirror')).toHaveCount(1);
    await expect(page.locator('.prose')).toContainText('Kept alive while hidden. Added while hidden.');
    expect(await page.locator('.ProseMirror').evaluate(element => (element as any).kept)).toBe(true);
    await expect(page.locator('#word-count')).toHaveText('7 words');
    await expect(second.locator('.collaboration-carets__caret')).toHaveCount(1);
    // Trashing the visible document destroys the only editor on the page; a kept one still gets the editor stylesheet.
    await page.locator('#menu-button').click(); await page.locator('#delete').click(); await expect(page.locator('#empty')).toBeVisible();
    await open(page, 'Elsewhere');
    expect(await page.locator('.ProseMirror').evaluate(element => getComputedStyle(element).whiteSpace)).toBe('break-spaces');
  } finally { await context.close(); }
});

test('typing pauses store the offline copy and search text from the background worker', async ({ page }) => {
  await login(page); const id = await note(page, 'Worker snapshot', 'A plain start.');
  await page.keyboard.type(' Quokka sighting.');
  const stored = () => page.evaluate(async id => {
    const user = JSON.parse(localStorage.getItem('ed-user')!); const request = indexedDB.open(`ed:${user.id}`);
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const content = await new Promise<any>(resolve => { const r = db.transaction('content').objectStore('content').get(id); r.onsuccess = () => resolve(r.result); });
    db.close(); return content?.markdown ?? '';
  }, id);
  await expect.poll(stored).toContain('A plain start. Quokka sighting.');
  await page.locator('#menu-button').click(); await page.locator('#search').fill('quokka');
  await expect(page.locator('.doc-row')).toHaveCount(1);
  await expect(page.locator('.doc-row')).toContainText('Worker snapshot');
});
