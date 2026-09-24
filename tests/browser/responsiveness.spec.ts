import { test, expect, type Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
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

test('a new document takes typing in its title at once, before it finishes opening', async ({ page }) => {
  await login(page); const previous = await note(page, 'Keeps its own title', 'The earlier document.');
  // Alt+N from inside the earlier document, then type without waiting for the new one to open.
  await page.locator('.prose').click(); await page.keyboard.press('Alt+N'); await page.keyboard.type('Named at once');
  await expect(page).not.toHaveURL(new RegExp(previous));
  await expect(page.getByLabel('Document title', { exact: true })).toHaveValue('Named at once');
  const id = new URL(page.url()).hash.slice(1);
  const titles = () => page.evaluate(async () => Object.fromEntries((await fetch('/api/documents').then(r => r.json())).map((d: any) => [d.id, d.title])));
  await expect.poll(titles).toMatchObject({ [previous]: 'Keeps its own title', [id]: 'Named at once' });
  await open(page, 'Keeps its own title'); await expect(page.locator('.prose')).toHaveText('The earlier document.');
});

test('signing in after a reinstall asks for a new password at once, in this tab and any other', async ({ browser }) => {
  // Its own account, which the test resets the way a reinstall leaves the admin one.
  const admin = await browser.newPage(); await login(admin);
  expect(await admin.evaluate(async body => { const { csrf } = await fetch('/api/me').then(r => r.json()); return (await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) })).status; }, { username: 'reinstalled', password, admin: false })).toBe(201);
  await admin.close();
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  const setPassword = async (tab: Page, current: string, next: string) => {
    await expect(tab.getByRole('heading', { name: 'Make this account yours.' })).toBeVisible();
    await tab.getByLabel('Current password', { exact: true }).fill(current); await tab.getByLabel('New password', { exact: true }).fill(next); await tab.getByLabel('Confirm new password').fill(next);
    await tab.getByRole('button', { name: 'Change password', exact: true }).click(); await expect(tab.locator('#menu-button')).toBeVisible();
  };
  try {
    await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('reinstalled'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const chosen = 'chosen-password-2026'; await setPassword(page, password, chosen);
    await note(page, 'Before the reinstall', 'Kept on this device.');
    const other = await context.newPage(); await other.goto('/'); await expect(other.locator('#menu-button')).toBeVisible();

    const mongo = await new MongoClient('mongodb://127.0.0.1:27018/ed_test').connect();
    try {
      const account = await mongo.db().collection('users').findOne({ username: 'reinstalled' });
      await mongo.db().collection('users').updateOne({ _id: account!._id }, { $set: { mustChangePassword: true } }); await mongo.db().collection('sessions').deleteMany({ userId: account!._id });
    } finally { await mongo.close(); }

    await page.reload();
    const signIn = page.locator('dialog', { hasText: 'Your local changes are retained.' });
    await signIn.getByLabel('Password', { exact: true }).fill(chosen); await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Make this account yours.' })).toBeVisible();
    // The other tab's next sync finds the same account waiting for a new password.
    await other.evaluate(() => dispatchEvent(new Event('online')));
    await expect(other.getByRole('heading', { name: 'Make this account yours.' })).toBeVisible();
    await setPassword(page, chosen, 'second-password-2026');
    await open(page, 'Before the reinstall'); await expect(page.locator('.prose')).toHaveText('Kept on this device.');
  } finally { await context.close(); }
});
