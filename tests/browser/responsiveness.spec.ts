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

test('a remembered account waits for the session check, and opens from the local copy when no answer comes', async ({ browser }) => {
  // Service workers would hide the session check from request interception.
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  try {
    await login(page); await note(page, 'Before the session check', 'Written before a slow session check.');
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/me', async route => { await held; await route.continue(); });
    await page.reload();
    // Nothing of the app until the server answers, or has had its three seconds.
    await page.waitForTimeout(1500);
    await expect(page.locator('#app')).toBeEmpty();
    await expect(page.locator('.prose')).toContainText('Written before a slow session check.');
    release();
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  } finally { await context.close(); }
});

test('a signed-out page shows only the sign-in page, and signing in reopens the local copy', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  try {
    await login(page); const id = await note(page, 'Kept through a sign-out', 'Written while signed in.');
    // The session ends elsewhere, as when it expires or another device changes the password.
    await page.evaluate(async () => { const { csrf } = await fetch('/api/me').then(r => r.json()); await fetch('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } }); });
    await page.locator('.prose').click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Typed after the session ended.');
    // The next sync learns of it and leaves for the sign-in page.
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const heading = page.getByRole('heading', { name: 'A place for your thoughts.' });
    await expect(heading).toBeVisible();
    const signedOut = async () => {
      await expect(heading).toBeVisible();
      await expect(page.locator('.workspace, #menu-button, #ai-button, #empty-new, dialog')).toHaveCount(0);
      await expect(page.getByLabel('Username', { exact: true })).toHaveValue('admin');
    };
    await signedOut();
    // Nor does a reload open the local copy, even when the server cannot be asked.
    await page.reload(); await signedOut();
    await page.route('**/api/me', route => route.abort());
    await page.reload(); await signedOut();
    await expect(page.getByRole('alert')).toContainText('can’t be reached');
    await page.unroute('**/api/me');
    const other = await context.newPage(); await other.goto('/'); await expect(other.getByRole('heading', { name: 'A place for your thoughts.' })).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Another tab waiting at the sign-in page is signed in with this one.
    await expect(other.locator('.prose')).toContainText('Written while signed in.');
    await other.close();
    await expect(page.locator('.prose')).toContainText('Written while signed in. Typed after the session ended.');
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    await expect.poll(() => page.evaluate(async id => (await fetch(`/api/documents/${id}/state`).then(r => r.json())).markdown, id)).toContain('Typed after the session ended.');
    // Signed in again, a reload opens the workspace as before.
    await page.reload(); await expect(page.locator('.prose')).toContainText('Typed after the session ended.');
  } finally { await context.close(); }
});

test('a session that ended while the app was closed opens the sign-in page, never the workspace', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  try {
    await login(page); await note(page, 'Closed before the sign-out', 'Not for a signed-out page.');
    await context.clearCookies();
    let workspaceShown = false;
    await page.exposeFunction('workspaceShown', () => { workspaceShown = true; });
    await page.addInitScript(() => { new MutationObserver(() => { if (document.querySelector('.workspace')) (window as any).workspaceShown(); }).observe(document, { childList: true, subtree: true }); });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'A place for your thoughts.' })).toBeVisible();
    await expect(page.getByText('Not for a signed-out page.')).toHaveCount(0);
    expect(workspaceShown).toBe(false);
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
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue('reinstalled');
    await page.getByLabel('Password', { exact: true }).fill(chosen); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Make this account yours.' })).toBeVisible();
    // The other tab's next sync finds the same account waiting for a new password, as does its sign-in page if it had already left for it.
    await other.evaluate(() => dispatchEvent(new Event('online')));
    await expect(other.getByRole('heading', { name: 'Make this account yours.' })).toBeVisible();
    await setPassword(page, chosen, 'second-password-2026');
    await open(page, 'Before the reinstall'); await expect(page.locator('.prose')).toHaveText('Kept on this device.');
  } finally { await context.close(); }
});
