// Real browser footage. Run only against the isolated promotional app.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const base = 'http://127.0.0.1:8082';
const raw = path.resolve('test-results/media');
const output = path.resolve('docs/media/garnet');
await mkdir(raw, { recursive: true });
await mkdir(output, { recursive: true });
// Credentials remain in ignored local artifacts, never in the finished media.
const credentialsFile = path.resolve('data/promo-runtime/capture-credentials.json');
let credentials;
try { credentials = JSON.parse(await readFile(credentialsFile, 'utf8')); }
catch { credentials = { password: randomUUID(), initial: randomUUID() }; await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 }); }

async function session(username, password) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username, password }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return { user: data.user, cookie, async api(route, method = 'GET', body) {
    const response = await fetch(`${base}/api${route}`, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': data.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${route}: ${result.error}`);
    return result;
  } };
}
let admin;
try { admin = await session('admin', credentials.password); }
catch { admin = await session('admin', 'password'); await admin.api('/password', 'POST', { current: 'password', password: credentials.password }); }
const accounts = await admin.api('/users');
for (const username of ['Alex', 'Sam']) {
  if (!accounts.some(u => u.username === username)) await admin.api('/users', 'POST', { username, password: credentials.initial, admin: false });
  let account;
  try { account = await session(username, credentials.password); }
  catch { account = await session(username, credentials.initial); await account.api('/password', 'POST', { current: credentials.initial, password: credentials.password }); }
}
const settings = await admin.api('/settings');
settings.agent.cwd = path.resolve('data/promo-workspace');
settings.agent.timeoutMinutes = 4;
await admin.api('/settings', 'PUT', settings);
if (!(await admin.api('/runner')).ok) throw new Error('The demo server agent executor is unavailable.');

const notes = [
  ['Launch day', 'A tiny app. A little more room to think.\n\n## The plan\n\n- Share a 30-second demo\n- Invite a friend to write together\n- Put the source on GitHub\n\n## The promise\n\nFast notes. Shared ideas. Your agents, right here.'],
  ['Weekend ideas', 'Less scrolling. More doing.\n\n## Good possibilities\n\n- Take the long way home\n- Make something small\n- Write down the idea before it disappears'],
  ['Launch checklist', 'A small launch with a clear story.\n\n## Ready when we are\n\n- [x] Give the app a name\n- [x] Make the editor feel fast\n- [ ] Record the demo\n- [ ] Share what we built\n\n## Together\n\nAlex is writing. Sam is making it better.'],
  ['Rough launch notes', 'Make something useful. Let people make it their own.\n\nWe need a short product demo, a README with screenshots, and a simple post for launch day. Invite a friend to try live editing. Publish the source under MIT.'],
  ['Next big idea', 'Start small. Keep going.\n\nA place to collect the thoughts worth coming back to.\n\n## First experiments\n\n- Capture the spark\n- Turn it into a draft\n- Bring someone along'],
  ['Field notes', 'Little observations from a busy week.\n\n## Things that worked\n\nA quiet workspace. A quick search. Picking up exactly where we left off.'],
];

const browser = await chromium.launch({ headless: true });
const errors = [];
const contexts = [];
async function login(username) {
  const auth = await session(username, credentials.password);
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 }, colorScheme: 'light', deviceScaleFactor: 1 });
  contexts.push(context);
  await context.addCookies([{ name: 'ed_session', value: auth.cookie.split('=')[1], url: base }]);
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await expect(page.locator('#menu-button')).toBeVisible();
  return page;
}
const alex = await login('Alex');
const existing = await admin.api('/documents');
const missing = notes.filter(([title]) => !existing.some(d => d.title === title && !d.deletedAt));
if (missing.length) {
  await alex.locator('#menu-button').click(); await alex.locator('#settings-button').click();
  await alex.getByRole('button', { name: 'Storage', exact: true }).click();
  await alex.locator('#import-files').setInputFiles(missing.map(([title, text]) => ({ name: `${title}.md`, mimeType: 'text/markdown', buffer: Buffer.from(text) })));
  if (await alex.getByLabel('Close', { exact: true }).isVisible()) await alex.getByLabel('Close', { exact: true }).click();
  await expect(alex.locator('.doc-row')).toHaveCount(notes.length);
}
const sam = await login('Sam');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function open(page, title) {
  if (await page.locator('#ai-panel').isVisible()) await page.locator('#close-ai').click();
  if (!(await page.locator('#search').isVisible())) { await page.locator('#menu-button').click(); await page.locator('#toggle-sidebar').click(); }
  await page.locator('#search').fill('');
  await page.locator('.doc-row').filter({ hasText: title }).first().click();
  await expect(page.getByLabel('Document title')).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: 'Document content' })).toBeVisible();
}
async function append(page, text) {
  await page.getByRole('textbox', { name: 'Document content' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text, { delay: 40 });
}
async function screenshot(name, page = alex) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pause(300);
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  await page.setViewportSize({ width: 1180, height: 760 });
}

const manifest = {};
async function record(name, seconds, action = async () => {}, page = alex) {
  const folder = path.join(raw, name);
  await mkdir(folder, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let first;
  const ready = new Promise(resolve => { first = resolve; });
  cdp.on('Page.screencastFrame', event => {
    const file = `${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(path.join(folder, file), Buffer.from(event.data, 'base64'));
    frames.push({ file, time: event.metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    first();
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: 1180, maxHeight: 760, everyNthFrame: 1 });
  await Promise.race([ready, pause(10000).then(() => { if (!frames.length) throw new Error('No browser frames'); })]);
  const start = performance.now();
  await action();
  const elapsed = (performance.now() - start) / 1000;
  if (elapsed > seconds) throw new Error(`${name} action took ${elapsed.toFixed(1)}s, longer than its ${seconds}s shot`);
  await pause((seconds - elapsed) * 1000);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  // Keep the original browser timestamps: never speed up typing or synchronization.
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const duration = i + 1 < frames.length ? frames[i + 1].time - frames[i].time : Math.max(0.04, seconds - (frames[i].time - frames[0].time));
    lines.push(`file '${frames[i].file}'`, `duration ${duration.toFixed(6)}`);
  }
  lines.push(`file '${frames.at(-1).file}'`);
  await writeFile(path.join(folder, 'frames.ffconcat'), lines.join('\n') + '\n');
  manifest[name] = { seconds, frames: frames.length, concat: path.relative(process.cwd(), path.join(folder, 'frames.ffconcat')) };
  await writeFile(path.join(raw, 'capture.json'), JSON.stringify(manifest, null, 2));
  console.log(`Recorded ${name}: ${seconds}s, ${frames.length} real browser frames`);
}

try {
  await open(alex, 'Launch day');
  await expect(alex.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  await screenshot('editor');
  await record('home', 4, async () => { await alex.mouse.move(800, 400); });
  await record('typing', 6, async () => {
    await open(alex, 'Weekend ideas');
    await append(alex, '\nMake room for the next idea.');
    await expect(alex.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  });
  await record('search', 6, async () => {
    await alex.locator('#search').click();
    await alex.keyboard.type('launch', { delay: 160 });
    await pause(650);
    await alex.locator('.doc-row').filter({ hasText: 'Launch day' }).click();
    await pause(300);
    await alex.locator('#search').fill('');
  });
  await expect.poll(() => alex.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await record('offline', 6, async () => {
    await alex.context().setOffline(true);
    await append(alex, '\nStill writing. Even offline.');
    await expect(alex.locator('#main')).toHaveAttribute('data-save-state', /offline|syncing/);
  });
  await alex.reload();
  await expect(alex.getByRole('textbox', { name: 'Document content' })).toContainText('Still writing. Even offline.');
  await alex.context().setOffline(false);
  await expect(alex.locator('#main')).toHaveAttribute('data-save-state', 'saved');
  console.log('Verified offline reload and reconnect');

  await open(alex, 'Launch checklist');
  await open(sam, 'Launch checklist');
  await alex.getByRole('textbox', { name: 'Document content' }).click();
  await alex.keyboard.press('Control+Home');
  await record('collaboration', 7, async () => {
    await append(sam, '\nSam: Let\'s ship something useful.');
    await expect(alex.getByRole('textbox', { name: 'Document content' })).toContainText("Sam: Let's ship something useful.");
  });
  await screenshot('collaboration');
  await record('sync', 6, async () => {
    await append(alex, '\nAlex: Ready when you are.');
    await expect(sam.getByRole('textbox', { name: 'Document content' })).toContainText('Alex: Ready when you are.');
  }, sam);
  console.log('Verified bidirectional collaboration');

  await open(alex, 'Rough launch notes');
  await record('agent-choice', 6, async () => {
    await alex.locator('#ai-button').click();
    await alex.getByLabel('Agent', { exact: true }).selectOption('codex');
    await pause(900);
    await alex.getByLabel('Agent', { exact: true }).selectOption('claude');
  });
  const jobs = [];
  for (const provider of ['claude', 'codex']) {
    if (provider === 'codex') {
      await alex.locator('#conversation').selectOption('');
      await alex.getByLabel('Agent', { exact: true }).selectOption('codex');
    }
    const prompt = provider === 'claude'
      ? 'Turn these rough notes into a launch checklist. Keep the intro. Use only Garnet document tools. Reply in one short sentence.'
      : 'Add an owner to each checklist item: Alex or Sam. Use only Garnet document tools. Reply in one short sentence.';
    let job;
    const requestStarted = Date.now();
    await record(`${provider}-prompt`, 6, async () => {
      await alex.locator('#ai-prompt').fill('');
      await alex.locator('#ai-prompt').pressSequentially(prompt, { delay: 18 });
      const response = alex.waitForResponse(r => r.url() === `${base}/api/jobs` && r.request().method() === 'POST');
      await alex.locator('#send-prompt').click();
      job = await (await response).json();
    });
    let result;
    for (let i = 0; i < 120; i++) {
      result = (await admin.api(`/conversations/${job.conversationId}/jobs`)).find(j => j._id === job.id);
      if (!['queued', 'running'].includes(result.status)) break;
      if (i % 10 === 0) console.log(`Waiting for real ${provider} job (${Math.round((Date.now() - requestStarted) / 1000)}s)`);
      await pause(2000);
    }
    if (result.status !== 'completed') throw new Error(`${provider}: ${result.status}: ${result.error || ''}`);
    await expect(alex.locator('#ai-status')).toHaveText('completed');
    const doc = await admin.api(`/documents/${new URL(alex.url()).hash.slice(1)}/state`);
    if (provider === 'claude' && !doc.markdown.includes('[ ]')) throw new Error('Claude did not create a checklist');
    if (provider === 'codex' && !/Alex|Sam/.test(doc.markdown)) throw new Error('Codex did not assign owners');
    jobs.push({ provider, status: result.status, elapsedSeconds: Math.round((Date.now() - requestStarted) / 1000), prompt, output: result.output, markdown: doc.markdown });
    await alex.locator('#main').evaluate(el => { el.scrollTop = 0; });
    await record(`${provider}-result`, 7, async () => { await alex.mouse.move(500, 400); });
    await screenshot(provider);
    console.log(`Verified ${provider} document edit`);
  }
  await open(sam, 'Rough launch notes');
  await record('agent-collaboration', 6, async () => {
    await append(sam, '\nSam: I\'ll take the screenshots.');
    await expect(alex.getByRole('textbox', { name: 'Document content' })).toContainText("Sam: I'll take the screenshots.");
  });
  await alex.locator('#close-ai').click();
  await record('navigate', 6, async () => {
    await open(alex, 'Next big idea');
    await pause(650);
    await open(alex, 'Field notes');
    await pause(650);
    await open(alex, 'Launch day');
  });
  await writeFile(path.join(raw, 'verification.json'), JSON.stringify({ date: new Date().toISOString(), origin: base, offlineReload: true, reconnected: true, collaboration: 'bidirectional', pageErrors: errors, jobs }, null, 2));
  if (errors.length) throw new Error(`Browser errors: ${errors.join(', ')}`);
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
}
