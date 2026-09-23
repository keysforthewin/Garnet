import { test, expect, type Page, type BrowserContext } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#menu-button')).toBeVisible();
}

async function note(page: Page, title: string) {
  const previous = page.url();
  await page.locator('#menu-button').click();
  await page.locator('#new-doc').click();
  await expect(page).not.toHaveURL(previous);
  await page.getByLabel('Document title', { exact: true }).fill(title);
  await page.locator('.prose').fill('A little room to think.\nWrite something worth keeping.');
  await expect(page.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  return new URL(page.url()).hash;
}

async function remembered(page: Page, hash: string) {
  await expect.poll(() => page.evaluate(async () => (await fetch('/api/preferences').then(r => r.json())).lastDocument)).toBe(hash.slice(1));
}

test('desktop navigation combines documents and actions without shifting the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page); await note(page, 'Desktop navigation');
  const before = await page.locator('#document').boundingBox();
  await expect(page.locator('#navigation')).not.toBeVisible();
  expect(await page.locator('.document-header').evaluate(e => e.getBoundingClientRect().height)).toBe(69);
  expect(await page.locator('#document').evaluate(e => getComputedStyle(e).padding)).toBe('57px 58px 40px');
  await page.locator('#menu-button').click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  await expect(page.locator('#navigation h2')).toHaveCount(0);
  await expect(page.locator('#navigation .wordmark')).toHaveCount(0);
  await expect(page.locator('.doc-row').filter({ hasText: 'Desktop navigation' })).toBeVisible();
  await expect(page.locator('#new-doc')).toBeVisible();
  await expect(page.locator('#toggle-sidebar')).toHaveCount(0);
  expect(await page.locator('#document').boundingBox()).toEqual(before);
  await page.screenshot({ path: 'test-results/navigation-desktop-open.png' });
  await page.locator('#account-button').focus(); await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#navigation'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-button')).toBeFocused();
  await expect(page.locator('#menu-button')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Control+k'); await expect(page.locator('#search')).toBeFocused();
  await page.locator('#search').fill('Desktop navigation');
  await expect(page.locator('.doc-row')).toHaveCount(1);
  await page.locator('.doc-row').click(); await expect(page.locator('#navigation')).not.toBeVisible();
  await page.locator('#menu-button').click(); await page.mouse.click(1200, 850);
  await expect(page.locator('#navigation')).not.toBeVisible();
  await page.screenshot({ path: 'test-results/navigation-desktop.png' });
  for (const width of [761, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.locator('.document-header').evaluate(e => e.getBoundingClientRect().height)).toBe(69);
    expect(await page.locator('#document-title').evaluate(e => getComputedStyle(e).fontSize)).toBe('34px');
  }
});

test('phone layouts reserve the viewport for writing in portrait and landscape', async ({ browser, page }) => {
  await login(page); const hash = await note(page, 'A little room to think'); await remembered(page, hash);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8081', storageState: await page.context().storageState(), isMobile: true, hasTouch: true });
  try {
    const mobile = await context.newPage(); await mobile.goto('/');
    await expect(mobile.locator('.prose')).toBeVisible();
    for (const [width, height] of [[320, 568], [375, 667], [390, 844], [412, 915], [430, 932], [844, 390], [760, 900], [390, 400]]) {
      await mobile.setViewportSize({ width, height });
      await mobile.locator('#main').evaluate(e => e.scrollTop = 0);
      const metrics = await mobile.evaluate(() => {
        const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return { header: rect('.document-header').height, editorTop: rect('.prose').top, editorWidth: rect('.prose').width,
          toolbar: rect('#toolbar').height, overflow: document.documentElement.scrollWidth > innerWidth,
          titleGap: rect('#toolbar').top - rect('#document-title').bottom,
          editorGap: rect('.prose').top - rect('#toolbar').bottom,
          toolbarScrolls: document.querySelector('#toolbar')!.scrollWidth > document.querySelector('#toolbar')!.clientWidth,
          rows: new Set([...document.querySelectorAll('#toolbar button')].map(e => e.getBoundingClientRect().top)).size,
          formattingTargets: [...document.querySelectorAll('#toolbar button')].every(e => {
            const r = e.getBoundingClientRect(); return r.height === 32 && r.width >= 44 && r.left >= 0 && r.right <= innerWidth;
          }),
          targets: [...document.querySelectorAll('#menu-button,#ai-button')].every(e => e.getBoundingClientRect().height >= 44 && e.getBoundingClientRect().width >= 44) };
      });
      expect(metrics, `${width}×${height}`).toMatchObject({ header: 44, toolbar: 64, overflow: false, targets: true, titleGap: 0, editorGap: 0, toolbarScrolls: false, rows: 2, formattingTargets: true });
      expect(metrics.editorTop).toBeLessThanOrEqual(146);
      expect(metrics.editorWidth).toBe(width - 8);
      await expect(mobile.locator('#navigation')).not.toBeVisible();
      await mobile.screenshot({ path: `test-results/mobile-${width}x${height}.png` });
    }
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.locator('#menu-button').tap();
    await mobile.screenshot({ path: 'test-results/mobile-navigation.png' });
    await mobile.locator('#collapse').tap();
    await mobile.locator('.prose').fill('Format this');
    await mobile.locator('.prose').press('Control+a');
    await mobile.locator('[data-command=bold]').tap();
    await expect(mobile.locator('.prose strong')).toHaveText('Format this');
    await expect(mobile.locator('[data-command=redo]')).toBeInViewport();
    await mobile.locator('#menu-button').tap();
    await mobile.locator('.doc-row').filter({ hasText: 'A little room to think' }).tap();
    await expect(mobile.locator('#navigation')).not.toBeVisible();
    await mobile.locator('#ai-button').tap(); await expect(mobile.locator('#ai-panel')).toBeVisible();
    await mobile.locator('#close-ai').tap(); await expect(mobile.locator('.prose')).toBeVisible();
    await mobile.getByLabel('Document title', { exact: true }).fill('A long heading that should never push the editor outside the phone viewport');
    await mobile.locator('.prose').fill(Array.from({ length: 20 }, (_, i) => `Paragraph ${i + 1}. Keep writing without running out of space. ${'LongWord'.repeat(12)}`).join('\n'));
    await mobile.locator('.prose').press('Control+End');
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await mobile.locator('.document-header').evaluate(e => e.getBoundingClientRect().top)).toBe(0);
    await mobile.emulateMedia({ colorScheme: 'dark' });
    await mobile.screenshot({ path: 'test-results/mobile-dark.png' });
  } finally { await context.close(); }
});

test('last document restores on a fresh device, root revisit, offline reload and explicit links', async ({ browser, page }) => {
  await login(page); const first = await note(page, 'Restore first'); const last = await note(page, 'Restore last');
  await remembered(page, last);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8081', storageState: await page.context().storageState(), viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  try {
    const fresh = await context.newPage(); await fresh.goto('/');
    await expect(fresh).toHaveURL(new RegExp(`${last}$`));
    await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Restore last');
    await expect(fresh.locator('#navigation')).not.toBeVisible();
    await fresh.goto('/'); await expect(fresh).toHaveURL(new RegExp(`${last}$`));
    await expect.poll(() => fresh.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true); await fresh.reload();
    await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Restore last');
    await context.setOffline(false); await fresh.goto(`/${first}`);
    await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Restore first');
    await fresh.goto('/#missing-document');
    await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Restore first');
    await expect(fresh.locator('#navigation')).not.toBeVisible();
  } finally { await context.close(); }
});

test('slow startup never replaces a document created while preferences load', async ({ browser, page }) => {
  await login(page); const hash = await note(page, 'Older remembered note'); await remembered(page, hash);
  const context: BrowserContext = await browser.newContext({ baseURL: 'http://127.0.0.1:8081', storageState: await page.context().storageState() });
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  try {
    const fresh = await context.newPage();
    let intercepted!: () => void;
    const pending = new Promise<void>(resolve => intercepted = resolve);
    await fresh.route('**/api/preferences', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      intercepted(); await gate; await route.continue();
    });
    await fresh.goto('/'); await pending;
    await fresh.locator('#menu-button').click(); await fresh.locator('#new-doc').click();
    await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Untitled');
    const selected = fresh.url(); release();
    await expect(fresh.locator('#main')).toHaveAttribute('data-save-state', 'saved');
    expect(fresh.url()).toBe(selected);
    await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Untitled');
  } finally { release(); await context.close(); }
});

test('an empty account starts with navigation closed and a usable new-document action', async ({ browser, page }) => {
  await login(page);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8081', storageState: await page.context().storageState(), viewport: { width: 375, height: 667 } });
  try {
    const fresh = await context.newPage();
    await fresh.route('**/api/preferences', route => route.request().method() === 'GET' ? route.fulfill({ json: {} }) : route.continue());
    await fresh.route('**/api/documents', route => route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue());
    await fresh.goto('/');
    await expect(fresh.locator('#empty-new')).toBeVisible();
    await expect(fresh.locator('#navigation')).not.toBeVisible();
    await fresh.locator('#menu-button').click();
    await expect(fresh.locator('#new-doc')).toBeEnabled();
    await expect(fresh.locator('#history')).toBeDisabled();
  } finally { await context.close(); }
});

test('restoring a document does not dismiss navigation opened during startup', async ({ browser, page }) => {
  await login(page); const hash = await note(page, 'Restore with menu open'); await remembered(page, hash);
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8081', storageState: await page.context().storageState() });
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  try {
    const fresh = await context.newPage();
    await fresh.route('**/api/preferences', async route => {
      if (route.request().method() === 'GET') await gate;
      await route.continue();
    });
    await fresh.goto('/'); await fresh.locator('#menu-button').click();
    release(); await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Restore with menu open');
    await expect(fresh.locator('#navigation')).toBeVisible();
    await expect(fresh.locator('#history')).toBeEnabled();
    await fresh.locator('#new-doc').click();
    await expect(fresh.getByLabel('Document title', { exact: true })).toHaveValue('Untitled');
    await expect(fresh.locator('#navigation')).not.toBeVisible();
  } finally { release(); await context.close(); }
});
