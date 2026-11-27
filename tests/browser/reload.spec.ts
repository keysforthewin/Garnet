import { test, expect } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
// A proxy in front of the test app. App files it is told to fail get the 404 Cloudflare hands
// browsers (kept for four hours); everything else passes through. Page routes would disable
// the browser cache, and the cache is the point.
async function proxy(fail: (path: string, count: number) => boolean) {
  const seen = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url!, 'http://proxy').pathname; const count = (seen.get(path) ?? 0) + 1; seen.set(path, count);
    if (path.startsWith('/assets/') && fail(path, count)) { res.writeHead(404, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=14400' }); res.end(); return; }
    const upstream = http.request({ host: '127.0.0.1', port: 8081, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode!, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}
const signIn = 'A place for your thoughts.';

test('a reload recovers when the browser has kept an error for the app’s own files', async ({ browser }) => {
  const app = await proxy((_path, count) => count === 1);
  const context = await browser.newContext({ baseURL: app.url }); const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: signIn })).toBeVisible();
    // The kept errors were replaced, so later reloads are ordinary.
    await page.reload(); await expect(page.getByRole('heading', { name: signIn })).toBeVisible();
  } finally { await context.close(); app.close(); }
});

test('when the app’s files keep failing, the page says so once and can try again', async ({ browser }) => {
  let failing = true; const app = await proxy(() => failing);
  const context = await browser.newContext({ baseURL: app.url }); const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Garnet couldn’t load.' })).toBeVisible();
    // One automatic reload, then no loop.
    await page.waitForTimeout(2000); expect(app.seen.get('/')).toBe(2);
    failing = false; await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: signIn })).toBeVisible();
  } finally { await context.close(); app.close(); }
});

test('a start that stalls says so instead of staying blank, and the app still opens when it can', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  try {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/me', async route => { await held; await route.continue(); });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Garnet couldn’t load.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    release();
    await expect(page.getByRole('heading', { name: signIn })).toBeVisible();
  } finally { await context.close(); }
});

test('the server never lets an error for an app file, or the page naming them, be kept', async ({ request }) => {
  const missing = await request.get('/assets/missing-file.js');
  expect(missing.status()).toBe(404); expect(missing.headers()['cache-control']).toBe('no-store');
  for (const path of ['/', '/index.html', '/sw.js', '/a/deep/link']) expect((await request.get(path)).headers()['cache-control'], path).toBe('no-cache');
});

test('the page names its icon, and each icon it or the installed app asks for is an image', async ({ page, request }) => {
  await page.goto('/');
  const linked = await page.locator('link[rel~=icon], link[rel=apple-touch-icon]').evaluateAll(links => links.map(link => new URL((link as HTMLLinkElement).href).pathname));
  expect(linked).toEqual(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png']);
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.icons).toHaveLength(3);
  // A file that is missing would come back as the page itself.
  for (const path of [...linked, ...manifest.icons.map((icon: { src: string }) => icon.src)]) expect((await request.get(path)).headers()['content-type'], path).toMatch(/^image\//);
});
