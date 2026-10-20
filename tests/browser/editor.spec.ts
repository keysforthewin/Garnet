import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const password = 'ed-test-password-2026';
async function login(page: Page, username = 'admin', pass = password) {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill(username); await page.getByLabel('Password', { exact: true }).fill(pass); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#menu-button').or(page.getByRole('heading', { name: 'Make this account yours.' }))).toBeVisible();
}
async function request(page: Page, url: string, method = 'GET', body?: any) {
  return page.evaluate(async ({ url, method, body }) => {
    const me = await fetch('/api/me').then(r => r.json()); const r = await fetch(`/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  }, { url, method, body });
}
test.describe.serial('shared editor', () => {
  test('bootstrap account must replace its password before accessing library', async ({ page }) => {
    await login(page, 'admin', 'password'); await expect(page.getByRole('heading', { name: 'Make this account yours.' })).toBeVisible();
    expect((await request(page, '/documents')).status).toBe(403);
    await page.getByLabel('Current password', { exact: true }).fill('password'); await page.getByLabel('New password', { exact: true }).fill(password); await page.getByLabel('Confirm new password').fill(password); await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(page.locator('#menu-button')).toBeVisible();
  });
  test('create, persist, collaborate, restore cursor, edit offline and reconnect', async ({ browser, page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page); await page.locator('#menu-button').click(); await page.locator('#new-doc').click();
    await page.getByLabel('Document title').fill('Shared field notes');
    const content = page.getByRole('textbox', { name: 'Document content' }); await content.click(); await page.keyboard.type('First paragraph.\n\nSecond paragraph.');
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    const id = new URL(page.url()).hash.slice(1);
    const snapshot = await request(page, `/documents/${id}/state`); expect(snapshot.data.markdown).toContain('First paragraph.');
    const secondContext = await browser.newContext(); const second = await secondContext.newPage(); await login(second);
    await second.locator('#menu-button').click(); await second.locator('.doc-row').filter({ hasText: 'Shared field notes' }).click();
    await expect(second.getByRole('textbox', { name: 'Document content' })).toContainText('Second paragraph.');
    await second.getByRole('textbox', { name: 'Document content' }).click(); await second.keyboard.press('Control+End'); await second.keyboard.type(' From collaborator.');
    await expect(content).toContainText('From collaborator.');
    const thirdContext = await browser.newContext(); const third = await thirdContext.newPage(); await login(third);
    await third.locator('#menu-button').click(); await third.locator('.doc-row').filter({ hasText: 'Shared field notes' }).click(); await third.getByRole('textbox', { name: 'Document content' }).click(); await third.keyboard.press('Control+End'); await third.keyboard.type(' Third writer.'); await expect(content).toContainText('Third writer.');
    await content.click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    const offset = await page.evaluate(() => window.getSelection()?.anchorOffset);
    await page.locator('#menu-button').click(); await page.locator('#new-doc').click(); await expect(page.getByLabel('Document title')).toHaveValue('Untitled');
    await page.locator('#menu-button').click(); await page.locator('.doc-row').filter({ hasText: 'Shared field notes' }).click();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(offset);
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await page.context().setOffline(true); await content.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Offline addition.');
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', /offline|syncing/);
    await page.reload(); await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Offline addition.');
    await second.getByRole('textbox', { name: 'Document content' }).click(); await second.keyboard.press('Control+Home'); await second.keyboard.type('Remote prefix. ');
    await page.context().setOffline(false);
    await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText('Remote prefix.');
    await expect(second.getByRole('textbox', { name: 'Document content' })).toContainText('Offline addition.');
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: 'test-results/editor-mobile.png', fullPage: true });
    expect(errors).toEqual([]); await secondContext.close(); await thirdContext.close();
  });
  test('account restriction, settings, Markdown export, trash, restore, and theme', async ({ browser, page }) => {
    await login(page); const created = await request(page, '/users', 'POST', { username: 'writer', password, admin: false }); expect(created.status).toBe(201);
    const context = await browser.newContext(); const writer = await context.newPage(); await login(writer, 'writer');
    await writer.getByLabel('Current password', { exact: true }).fill(password); await writer.getByLabel('New password', { exact: true }).fill(`${password}-changed`); await writer.getByLabel('Confirm new password').fill(`${password}-changed`); await writer.getByRole('button', { name: 'Change password', exact: true }).click(); await expect(writer.locator('#menu-button')).toBeVisible();
    expect((await request(writer, '/users', 'POST', { username: 'forbidden', password })).status).toBe(403);
    expect((await request(writer, '/settings')).status).toBe(200);
    expect((await request(writer, '/settings')).data).not.toHaveProperty('httpsAddress');
    expect((await request(writer, '/certificate')).status).toBe(404);
    await page.locator('#menu-button').click(); await page.locator('.doc-row').filter({ hasText: 'Shared field notes' }).click();
    const download = page.waitForEvent('download'); await page.locator('#menu-button').click(); await page.locator('#export-button').click(); const exported = await download; expect(exported.suggestedFilename()).toMatch(/Shared-field-notes--.*\.md/); expect(await readFile((await exported.path())!, 'utf8')).toContain('Offline addition.');
    await page.locator('#menu-button').click(); await page.getByRole('button', { name: 'Move to trash' }).click(); await expect(page.getByRole('heading', { name: 'Room to think.' })).toBeVisible();
    await page.locator('#menu-button').click(); await page.locator('#trash-button').click(); await page.locator('.doc-row').filter({ hasText: 'Shared field notes' }).click(); await page.getByRole('button', { name: 'Restore', exact: true }).click(); await page.locator('#trash-button').click(); await expect(page.locator('.doc-row').filter({ hasText: 'Shared field notes' })).toBeVisible(); await page.keyboard.press('Escape');
    await page.locator('#menu-button').click(); await page.locator('#settings-button').click(); await page.getByLabel('Appearance').selectOption('dark'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await page.getByLabel('Close', { exact: true }).click();
    await page.screenshot({ path: 'test-results/editor-dark.png' }); await context.close();
  });
  test('autolinks end where the URL ends, and pasted images upload into the document', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await login(page); await page.locator('#menu-button').click(); await page.locator('#new-doc').click();
    await page.getByLabel('Document title').fill('Links and images');
    const content = page.getByRole('textbox', { name: 'Document content' }); await content.click();
    // Backspacing into an autolink and typing on must not extend the link.
    await page.keyboard.type('Try fal.ai '); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.type('i more words');
    await expect(content.locator('a')).toHaveCount(1); await expect(content.locator('a')).toHaveText('fal.ai'); await expect(content).toContainText('Try fal.ai more words');
    // Correcting a URL keeps it one link pointing at the corrected address.
    await page.keyboard.press('Enter'); await page.keyboard.type('fal.ai/mdoels ');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type('odels and on');
    const fixed = content.locator('p').nth(1).locator('a'); await expect(fixed).toHaveCount(1); await expect(fixed).toHaveText('fal.ai/models'); await expect(fixed).toHaveAttribute('href', 'http://fal.ai/models');
    await page.keyboard.press('Enter');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await page.evaluate(png => {
      const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
      document.querySelector('.prose')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, png);
    const image = content.locator('img[src^="/api/images/"]'); await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
    const src = (await image.getAttribute('src'))!;
    expect(await page.evaluate(async src => { const r = await fetch(src); return [r.status, r.headers.get('content-type')]; }, src)).toEqual([200, 'image/png']);
    await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    const id = new URL(page.url()).hash.slice(1);
    await expect.poll(async () => (await request(page, `/documents/${id}/state`)).data.markdown).toContain(`![](${src})`);
    // Only real raster images are accepted.
    const rejected = await page.evaluate(async () => {
      const me = await fetch('/api/me').then(r => r.json());
      const post = (type: string, body: string) => fetch('/api/images', { method: 'POST', headers: { 'Content-Type': type, 'X-CSRF-Token': me.csrf }, body }).then(r => r.status);
      return [await post('image/png', 'not an image'), await post('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>')];
    });
    expect(rejected).toEqual([400, 400]);
    await page.reload(); await expect(page.getByRole('textbox', { name: 'Document content' }).locator(`img[src="${src}"]`)).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});
