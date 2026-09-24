import { test, expect, type Page } from '@playwright/test';
import { writeFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
const secret = randomBytes(32).toString('hex');
const runtime = path.resolve('data/test-runtime');
const password = 'ed-test-password-2026';
function tool(name: string, args = {}): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path.join(runtime, 'app.sock'), path: '/tool', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` } }, res => {
      let raw = ''; res.on('data', part => raw += part); res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(JSON.stringify({ name, arguments: args }));
  });
}
async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#menu-button')).toBeVisible();
}
test.beforeAll(async ({ request: api }) => {
  // Standalone runs start with the bootstrap account; the full suite changes it earlier.
  const login = await api.post('/api/login', { data: { username: 'admin', password: 'password' } });
  if (login.ok()) { const { csrf } = await login.json(); await api.post('/api/password', { headers: { 'x-csrf-token': csrf }, data: { current: 'password', password } }); }
  await writeFile(path.join(runtime, 'mcp-token'), secret + '\n', { mode: 0o600 });
});
test.afterAll(async () => { await rm(path.join(runtime, 'mcp-token'), { force: true }); });

test('MCP creates task lists, guards stale edits, and rejects invalid creates without empty notes', async () => {
  const before = await tool('list_documents');
  expect((await tool('create_document', { title: 'Invalid', markdown: 123 })).status).toBe(400);
  expect((await tool('list_documents')).data.length).toBe(before.data.length);
  const created = await tool('create_document', { title: 'MCP checklist', markdown: '- [ ] Write notes\n- [x] Connect Garnet' });
  expect(created.status).toBe(200); expect(created.data.version).toBeTruthy();
  const read = await tool('read_document', { id: created.data.id });
  expect(read.data.markdown).toContain('- [ ] Write notes');
  const edit = await tool('edit_document', { id: created.data.id, version: read.data.version, find: 'Write notes', replace: 'Review notes' });
  expect(edit.status).toBe(200);
  expect((await tool('edit_document', { id: created.data.id, version: read.data.version, markdown: 'Stale overwrite' })).status).toBe(409);
  expect((await tool('read_document', { id: created.data.id })).data.markdown).toContain('Review notes');
});

test('short edits show a moving Garnet caret in both browsers while content is already saved', async ({ page, browser }) => {
  const created = await tool('create_document', { title: 'MCP live typing', markdown: 'Start.' });
  await login(page); await page.goto(`/#${created.data.id}`);
  const content = page.getByRole('textbox', { name: 'Document content' }); await expect(content).toHaveText('Start.');
  const context = await browser.newContext(); const second = await context.newPage(); await login(second); await second.goto(`/#${created.data.id}`);
  await expect(second.getByRole('textbox', { name: 'Document content' })).toHaveText('Start.');
  // Wait for collaboration readiness, not merely the locally cached document.
  await expect(page.locator('#people')).toContainText('2 people');
  const read = await tool('read_document', { id: created.data.id });
  const addition = 'Fast animated Garnet typing. '.repeat(12);
  const response = await tool('edit_document', { id: created.data.id, version: read.data.version, markdown: `Start. ${addition}` });
  expect(response.status).toBe(200);
  await expect(page.locator('.garnet-agent-caret')).toBeVisible();
  await expect(second.locator('.garnet-agent-caret')).toBeVisible();
  await expect(page.locator('.garnet-edit-hidden').first()).toBeAttached();
  const position = await page.locator('.garnet-agent-caret').getAttribute('data-position');
  await expect(page.locator('.garnet-agent-caret')).not.toHaveAttribute('data-position', position!);
  expect((await tool('read_document', { id: created.data.id })).data.markdown).toContain(addition.trim());
  await page.screenshot({ path: 'test-results/garnet-mcp-typing.png' });
  // An interaction immediately reveals committed text without changing it.
  await content.click(); await expect(page.locator('.garnet-edit-hidden')).toHaveCount(0);
  await expect(page.locator('.garnet-agent-caret')).toHaveCount(0, { timeout: 5000 });
  await context.close();
});

test('large edits and reduced motion use highlights; human edits still reject stale agent versions', async ({ page }) => {
  const created = await tool('create_document', { title: 'MCP large edit', markdown: 'Opening.' });
  await login(page); await page.goto(`/#${created.data.id}`);
  const content = page.getByRole('textbox', { name: 'Document content' }); await expect(content).toHaveText('Opening.');
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  const read = await tool('read_document', { id: created.data.id });
  const text = 'Large document text. '.repeat(200);
  expect((await tool('edit_document', { id: created.data.id, version: read.data.version, markdown: text })).status).toBe(200);
  await expect(page.locator('.garnet-edit-highlight').first()).toBeAttached();
  await expect(page.locator('.garnet-edit-hidden')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const next = await tool('read_document', { id: created.data.id });
  await tool('edit_document', { id: created.data.id, version: next.data.version, markdown: text + ' Emoji: 👨‍👩‍👧‍👦 é.' });
  await expect(content).toContainText('Emoji:'); await expect(page.locator('.garnet-edit-hidden')).toHaveCount(0);
  const stale = await tool('read_document', { id: created.data.id });
  await content.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' Human contribution.');
  await expect.poll(async () => (await tool('read_document', { id: created.data.id })).data.markdown).toContain('Human contribution.');
  expect((await tool('edit_document', { id: created.data.id, version: stale.data.version, markdown: 'Overwrite' })).status).toBe(409);
});

test('a burst exceeding the remaining two-second queue budget reveals all text immediately', async ({ page }) => {
  const created = await tool('create_document', { title: 'MCP queued effects', markdown: 'Queue.' });
  await login(page); await page.goto(`/#${created.data.id}`);
  await expect(page.getByRole('textbox', { name: 'Document content' })).toHaveText('Queue.');
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  const read = await tool('read_document', { id: created.data.id });
  const first = 'a'.repeat(440);
  const firstEdit = await tool('edit_document', { id: created.data.id, version: read.data.version, markdown: `Queue. ${first}` });
  await expect(page.locator('.garnet-edit-hidden').first()).toBeAttached();
  const second = 'b'.repeat(440);
  await tool('edit_document', { id: created.data.id, version: firstEdit.data.version, markdown: `Queue. ${first} ${second}` });
  await expect(page.getByRole('textbox', { name: 'Document content' })).toContainText(second);
  await expect(page.locator('.garnet-edit-hidden')).toHaveCount(0);
  await expect(page.locator('.garnet-edit-highlight').first()).toBeAttached();
});
