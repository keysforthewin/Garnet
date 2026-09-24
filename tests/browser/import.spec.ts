import { test, expect, type Page } from '@playwright/test';
import { docx, pdf } from '../fixtures/document-files';

async function cursor(page: Page, offset: number) {
  const point = await page.locator('.prose p').first().evaluate((element, offset) => {
    const range = document.createRange(); range.setStart(element.firstChild!, offset); range.setEnd(element.firstChild!, offset);
    const rect = range.getBoundingClientRect(); return { x: rect.left + 0.1, y: rect.top + rect.height / 2 };
  }, offset);
  await page.mouse.click(point.x, point.y);
  // Browser selectionchange is asynchronous; wait for the editor to observe it
  // before moving focus out of the editor or starting the next keyboard action.
  await expect.poll(() => page.locator('.prose').evaluate(element => (element as any).editor.state.selection.head)).toBe(offset + 1);
}

async function drop(page: Page, files: { name: string; text?: string; bytes?: number[]; type?: string }[], selector = '.prose', offset = 6) {
  return page.evaluate(({ files, selector, offset }) => {
    const element = document.querySelector(selector)!;
    let rect = element.getBoundingClientRect();
    if (selector === '.prose') {
      const node = element.querySelector('p')!.firstChild!;
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset);
      rect = range.getBoundingClientRect();
    }
    const dataTransfer = new DataTransfer();
    for (const file of files) dataTransfer.items.add(new File([file.bytes ? new Uint8Array(file.bytes) : file.text || ''], file.name, { type: file.type || '' }));
    const dragover = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + 0.1, clientY: rect.top + rect.height / 2 });
    element.dispatchEvent(dragover);
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + 0.1, clientY: rect.top + rect.height / 2 });
    element.dispatchEvent(event);
    return { prevented: event.defaultPrevented, accepted: dragover.defaultPrevented };
  }, { files, selector, offset });
}

test.beforeEach(async ({ page }) => {
  let login = await page.request.post('/api/login', { data: { username: 'admin', password: 'ed-test-password-2026' } });
  if (!login.ok()) {
    login = await page.request.post('/api/login', { data: { username: 'admin', password: 'password' } });
    const { csrf } = await login.json();
    expect((await page.request.post('/api/password', { headers: { 'X-CSRF-Token': csrf }, data: { current: 'password', password: 'ed-test-password-2026' } })).ok()).toBe(true);
  }
  await page.goto('/'); await page.locator('#menu-button').click(); await page.locator('#new-doc').click();
  await expect(page.getByLabel('Document title')).toHaveValue('Untitled');
  await page.locator('.prose').fill('BeforeAfter');
});

test('inserts literal text at the pointer, preserves line breaks, and undoes as one action', async ({ page }) => {
  await page.keyboard.press('Control+End');
  expect(await drop(page, [{ name: 'note.txt', text: '<b>literal</b>\r\nnext' }])).toEqual({ prevented: true, accepted: true });
  await expect(page.locator('.prose p')).toHaveText(['Before<b>literal</b>', 'nextAfter']);
  await expect(page.locator('.prose b')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.prose')).toHaveText('BeforeAfter');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.prose p')).toHaveText(['Before<b>literal</b>', 'nextAfter']);
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  await page.reload(); await expect(page.locator('.prose p')).toHaveText(['Before<b>literal</b>', 'nextAfter']);
});

for (const selector of ['#document-title', '.document-header', '#sidebar', 'body']) {
  test(`drops on ${selector} use the last editor cursor`, async ({ page }) => {
    await cursor(page, 6);
    if (selector === '#sidebar') await page.locator('#menu-button').click();
    else await page.getByLabel('Document title').focus();
    expect(await drop(page, [{ name: 'note.md', text: '# inserted ' }], selector)).toEqual({ prevented: true, accepted: true });
    await expect(page.locator('.prose')).toHaveText('Before# inserted After');
    await expect(page.locator('.prose h1')).toHaveCount(0);
    if (selector === '#sidebar') await page.keyboard.press('Escape');
  });
}

test('multiple documents insert in order while unsupported and empty files leave no garbage', async ({ page }) => {
  await drop(page, [
    { name: 'one.txt', text: 'First' }, { name: 'image.png', bytes: [137, 80, 78, 71] },
    { name: 'empty.txt', text: '' }, { name: 'two.md', text: 'Second' },
  ]);
  await expect(page.locator('.prose p')).toHaveText(['BeforeFirst', '', 'SecondAfter']);
  await expect(page.locator('#toast')).toContainText('image.png: Unsupported');
  await expect(page.locator('#toast')).toContainText('empty.txt: No readable text');
  await page.keyboard.press('Control+z'); await expect(page.locator('.prose')).toHaveText('BeforeAfter');
});

test('real PDF and DOCX uploads extract on the server and insert at the drop position', async ({ page }) => {
  await drop(page, [{ name: 'report.pdf', bytes: [...pdf()] }, { name: 'report.docx', bytes: [...docx()] }]);
  await expect(page.locator('.prose')).toContainText('PDF document text');
  await expect(page.locator('.prose')).toContainText('Word document text');
  const text = await page.locator('.prose').innerText();
  expect(text.indexOf('Before')).toBeLessThan(text.indexOf('PDF document text'));
  expect(text.indexOf('PDF document text')).toBeLessThan(text.indexOf('Word document text'));
  expect(text.indexOf('Word document text')).toBeLessThan(text.indexOf('After'));
});

test('delayed extraction tracks the drop anchor through continued typing', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const intercepted = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/document-text?*', async route => { received(); await gate; await route.fulfill({ json: { text: 'IMPORTED' } }); });
  await drop(page, [{ name: 'slow.docx', bytes: [...docx()] }]); await intercepted;
  await cursor(page, 0); await page.keyboard.type('NEW ');
  await expect(page.locator('.prose')).toHaveText('NEW BeforeAfter');
  release();
  await expect(page.locator('.prose')).toHaveText('NEW BeforeIMPORTEDAfter');
  await page.keyboard.type('MORE ');
  await expect(page.locator('.prose')).toHaveText('NEW MORE BeforeIMPORTEDAfter');
});

test('switching documents during extraction never inserts into the new document', async ({ page }) => {
  await page.getByLabel('Document title').fill('Import destination');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const intercepted = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/document-text?*', async route => { received(); await gate; await route.fulfill({ json: { text: 'IMPORTED' } }); });
  await drop(page, [{ name: 'slow.docx', bytes: [...docx()] }]); await intercepted;
  await page.locator('#menu-button').click(); await page.locator('#new-doc').click();
  await expect(page.getByLabel('Document title')).toHaveValue('Untitled');
  await page.locator('.prose').fill('Other document'); release();
  await expect(page.locator('#toast')).toHaveText('Inserted document text.');
  await expect(page.locator('.prose')).toHaveText('Other document');
  await page.locator('#menu-button').click(); await page.locator('.doc-row').filter({ hasText: 'Import destination' }).click();
  await expect(page.locator('.prose')).toHaveText('BeforeIMPORTEDAfter');
});

test('plain text works offline and failed conversion preserves the document', async ({ page }) => {
  await page.context().setOffline(true);
  await drop(page, [{ name: 'offline.txt', text: 'OFFLINE' }]);
  await expect(page.locator('.prose')).toHaveText('BeforeOFFLINEAfter');
  await page.context().setOffline(false);
  await drop(page, [{ name: 'broken.pdf', text: 'not a PDF' }]);
  await expect(page.locator('#toast')).toContainText('broken.pdf:');
  await expect(page.locator('.prose')).toHaveText('BeforeOFFLINEAfter');
});

test('extraction endpoint requires authentication and CSRF', async ({ page, playwright }) => {
  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:8081' });
  try {
    expect((await anonymous.post('/api/document-text?name=test.pdf', { data: pdf(), headers: { 'Content-Type': 'application/octet-stream' } })).status()).toBe(401);
    expect((await page.request.post('/api/document-text?name=test.pdf', { data: pdf(), headers: { 'Content-Type': 'application/octet-stream' } })).status()).toBe(403);
    const { csrf } = await (await page.request.get('/api/me')).json();
    expect((await page.request.post('/api/document-text?name=test.exe', { data: 'binary', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf } })).status()).toBe(400);
  } finally { await anonymous.dispose(); }
});
