import { test, expect, type Page } from '@playwright/test';
import { stat } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
async function api(page: Page, url: string, method = 'GET', body?: any) {
  return page.evaluate(async ({ url, method, body }) => {
    const me = await fetch('/api/me').then(r => r.json());
    const response = await fetch(`/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { url, method, body });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
});
test('navigation pins preserve the selected document and the combined menu', async ({ page }) => {
  await expect(page.locator('#menu-button')).toBeVisible(); const previousUrl = page.url();
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click(); await expect(page).not.toHaveURL(previousUrl); await expect(page.getByLabel('Document title')).toHaveValue('Untitled'); await page.getByLabel('Document title').fill('Pinned note');
  const id = new URL(page.url()).hash.slice(1);
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click(); await expect(page).not.toHaveURL(new RegExp(`${id}$`)); await expect(page.getByLabel('Document title')).toHaveValue('Untitled'); await page.getByLabel('Document title').fill('Active note');
  await page.locator('#menu-button').click(); await page.locator(`[data-pin="${id}"]`).click();
  await expect(page.getByLabel('Document title')).toHaveValue('Active note');
  await expect(page.locator('.doc-row').first()).toContainText('Pinned note');
  await expect(page.locator(`[data-pin="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pin, #original, #duplicate, #cache-status, #toggle-sidebar')).toHaveCount(0);
  expect(await page.locator('#document-menu button').evaluateAll(buttons => buttons.map(button => button.id))).toEqual(['new-doc', 'export-button', 'history', 'settings-button', 'delete']);
  await expect(page.locator('#sidebar #settings-button')).toBeVisible();
  await expect(page.locator('#new-doc kbd')).toHaveText('Alt N');
  await expect(page.locator('#sidebar')).not.toContainText('available offline');
  await page.keyboard.press('Escape');
  await page.reload(); await expect(page.locator('#navigation')).not.toBeVisible(); await page.locator('#menu-button').click(); await expect(page.locator(`[data-pin="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator(`[data-pin="${id}"]`).click(); await expect(page.locator(`[data-pin="${id}"]`)).toHaveAttribute('aria-pressed', 'false');
  const beforeShortcut = page.url(); await page.keyboard.press('Alt+n'); await expect(page).not.toHaveURL(beforeShortcut); await expect(page.getByLabel('Document title')).toHaveValue('Untitled');
});
test('only changed content creates a version, with colored differences and safe restore', async ({ page }) => {
  await expect(page.getByLabel('Document title')).toBeVisible();
  const previousUrl = page.url();
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click();
  await expect(page).not.toHaveURL(previousUrl);
  await expect(page.getByLabel('Document title')).toHaveValue('Untitled');
  await page.getByLabel('Document title').fill('Version checks');
  const id = new URL(page.url()).hash.slice(1);
  await page.locator('.prose').fill('First wording.');
  await expect.poll(async () => (await api(page, `/documents/${id}/state`)).data.markdown).toBe('First wording.');
  const first = (await api(page, `/documents/${id}/revisions`)).data;
  expect(first).toHaveLength(1); expect(first[0].previousMarkdown).toBe(''); expect(first[0].markdown).toBe('First wording.');
  const stale = (await api(page, `/documents/${id}/content`)).data.version;
  await page.locator('.prose').fill('Second wording.');
  await expect.poll(async () => (await api(page, `/documents/${id}/state`)).data.markdown).toBe('Second wording.');
  const versions = (await api(page, `/documents/${id}/revisions`)).data; expect(versions).toHaveLength(2);
  await expect.poll(async () => { const d = (await api(page, `/documents/${id}/state`)).data; return d.mirrorRevision === d.revision; }).toBe(true);
  const saved = (await api(page, `/documents/${id}/state`)).data;
  const mirrorPath = `data/test-documents/${saved.filename}`; const modified = (await stat(mirrorPath)).mtimeMs;
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+s');
  await page.waitForTimeout(6000); // Longer than the configured maximum autosave interval.
  const current = (await api(page, `/documents/${id}/content`)).data;
  expect((await api(page, `/documents/${id}/restore`, 'POST', { revisionId: versions[0]._id, version: current.version })).status).toBe(200);
  expect((await api(page, `/documents/${id}/restore`, 'POST', { revisionId: first[0]._id, version: stale })).status).toBe(409);
  const unchanged = (await api(page, `/documents/${id}/state`)).data;
  expect(unchanged.revision).toBe(saved.revision); expect(unchanged.updatedAt).toBe(saved.updatedAt); expect((await stat(mirrorPath)).mtimeMs).toBe(modified);
  const mongo = await new MongoClient('mongodb://127.0.0.1:27018/ed_test').connect();
  try { expect(await mongo.db().collection('revisions').countDocuments({ docId: id })).toBe(2); } finally { await mongo.close(); }
  await page.locator('#menu-button').click(); await page.locator('#history').click();
  await page.locator('[data-revision]').first().click();
  await expect(page.locator('.diff-change .diff-removed')).toContainText('First wording.');
  await expect(page.locator('.diff-change .diff-added')).toContainText('Second wording.');
  await page.screenshot({ path: 'test-results/version-diff.png' });
  await page.locator('.revision-dialog [data-close]').click();
  await page.locator(`[data-revision="${first[0]._id}"]`).click();
  await page.locator('#apply-revision').click(); await expect(page.locator('.prose')).toHaveText('First wording.');
  await expect.poll(async () => (await api(page, `/documents/${id}/revisions`)).data.length).toBe(3);
});
test('separate model selectors refresh changed executable paths and preserve custom overrides', async ({ page }) => {
  await page.locator('#menu-button').click(); await page.locator('#settings-button').click(); await page.locator('[data-tab=agents]').click();
  await expect(page.locator('[name=claudeModel]')).toBeVisible(); await expect(page.locator('[name=codexModel]')).toBeVisible();
  const original = (await api(page, '/settings')).data;
  try {
    await page.locator('[name=claudePath]').fill('/missing/garnet-cli'); await page.locator('[name=claudePath]').press('Tab');
    await expect(page.locator('#claude-models-status')).toContainText('not found');
    await page.locator('[name=claudeModel]').selectOption('__custom__'); await page.locator('[name=claudeCustomModel]').fill('claude-custom');
    await page.locator('[name=codexModel]').selectOption('__custom__'); await page.locator('[name=codexCustomModel]').fill('codex-custom');
    await page.locator('#save-settings').click();
    await expect.poll(async () => (await api(page, '/settings')).data.agent.claudeModel).toBe('claude-custom');
    expect((await api(page, '/settings')).data.agent.codexModel).toBe('codex-custom');
    await page.locator('[data-close]').click(); await page.locator('#menu-button').click(); await page.locator('#settings-button').click(); await page.locator('[data-tab=agents]').click();
    await expect(page.locator('[name=claudeCustomModel]')).toHaveValue('claude-custom'); await expect(page.locator('[name=codexCustomModel]')).toHaveValue('codex-custom');
  } finally { await api(page, '/settings', 'PUT', original); }
});
