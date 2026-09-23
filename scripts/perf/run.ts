// Frontend performance harness. Measures one build end to end in Chromium:
// bundle size, cold and warm load, menu and document switching, search,
// sustained typing (normal and large documents) and live collaboration.
//
//   npx tsx scripts/perf/run.ts --label after              # measures ./build
//   npx tsx scripts/perf/run.ts --ref HEAD --label before  # builds HEAD in a worktree first
//   npx tsx scripts/perf/compare.ts perf-results/before.json perf-results/after.json
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { instrument } from './instrument';
import { quantile, summary } from './stats';
import { buildRef, docId, docTitle, LARGE_ID, seed, sleep, startMongo, startServer, USER } from './env';

const { values: options } = parseArgs({ options: {
  build: { type: 'string', default: 'build' }, ref: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' },
  mongo: { type: 'string' }, cpu: { type: 'string', default: '4' }, docs: { type: 'string', default: '500' },
  only: { type: 'string' }, quick: { type: 'boolean', default: false }, headed: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false }, profile: { type: 'boolean', default: false },
} });
const cpuRate = Number(options.cpu); const documentCount = Number(options.docs); const quick = options.quick;
const only = options.only?.split(',');
const enabled = (name: string) => !only || only.includes(name);
const samples: Record<string, Record<string, number[]>> = {};
const details: Record<string, any> = {};
const record = (scenario: string, metric: string, ...values: number[]) => { ((samples[scenario] ??= {})[metric] ??= []).push(...values.map(v => Number(v.toFixed(3)))); };
const log = (message: string) => console.log(`[perf ${new Date().toISOString().slice(11, 19)}] ${message}`);
declare global { interface Window { __perf: any } }

async function newContext(browser: Browser, url: string) {
  const context = await browser.newContext({ baseURL: url, viewport: { width: 1280, height: 900 } });
  await context.addInitScript('window.__name = fn => fn');
  await context.addInitScript(instrument);
  const login = await context.request.post('/api/login', { data: { username: USER.username, password: USER.password } });
  if (!login.ok()) throw new Error(`Sign-in failed: ${await login.text()}`);
  return context;
}
async function openPage(context: BrowserContext) {
  const page = await context.newPage(); const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  page.on('pageerror', error => log(`page error: ${error.message}`));
  return { page, cdp };
}
async function cpuMetrics(cdp: CDPSession) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value])) as Record<string, number>;
}
// --profile saves a CPU profile of one measured window per scenario (summarize with profile.ts).
// Profiling adds overhead, so compare profiled runs only with other profiled runs.
const profiled = new Set<string>();
async function startProfile(cdp: CDPSession, name: string) {
  if (!options.profile || profiled.has(name)) return false;
  profiled.add(name); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); return true;
}
async function stopProfile(cdp: CDPSession, name: string, started: boolean) {
  if (!started) return;
  const { profile } = await cdp.send('Profiler.stop'); const file = `perf-results/${(options.label || 'profile').replace(/[^\w.-]+/g, '-')}-${name}.cpuprofile`;
  await mkdir('perf-results', { recursive: true }); await writeFile(file, JSON.stringify(profile)); log(`saved ${file}`);
}
// Waits until no fetch is in flight and nothing (fetch, IndexedDB write, long frame) happened for `ms`.
async function quiet(page: Page, ms = 1000) {
  await page.waitForFunction(ms => window.__perf.inflight === 0 && performance.now() - window.__perf.lastActivity > ms, ms, { timeout: 120000, polling: 100 });
}
async function load(page: Page, hash = docId(0)) {
  await page.goto(`/#${hash}`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__perf.marks.content, undefined, { timeout: 600000, polling: 100 });
}

function bundle(buildDir: string) {
  return (async () => {
    const dir = path.join(buildDir, 'public/assets'); const files = await readdir(dir); const rows: { file: string; rawKB: number; gzipKB: number; brotliKB: number }[] = [];
    for (const file of files.filter(f => /\.(js|css)$/.test(f))) {
      const data = await readFile(path.join(dir, file));
      rows.push({ file, rawKB: data.length / 1024, gzipKB: gzipSync(data).length / 1024, brotliKB: brotliCompressSync(data).length / 1024 });
    }
    rows.sort((a, b) => b.rawKB - a.rawKB); details.bundle = rows;
    const sum = (key: 'rawKB' | 'gzipKB' | 'brotliKB', filter: (f: string) => boolean) => rows.filter(r => filter(r.file)).reduce((total, r) => total + r[key], 0);
    record('bundle', 'totalJsGzipKB', sum('gzipKB', f => f.endsWith('.js')));
    record('bundle', 'totalJsRawKB', sum('rawKB', f => f.endsWith('.js')));
    record('bundle', 'cssGzipKB', sum('gzipKB', f => f.endsWith('.css')));
  })();
}

// A new device: no service worker, no IndexedDB. The session cookie already exists.
async function coldLoad(browser: Browser, url: string, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    const context = await newContext(browser, url); const { page } = await openPage(context);
    await load(page, '');
    const result = await page.evaluate(() => {
      const P = window.__perf; const assets = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const bytes = (ext: string) => assets.filter(a => a.startTime < P.marks.shell && new URL(a.name).pathname.endsWith(ext)).reduce((total, a) => total + a.encodedBodySize, 0);
      return { ...P.marks, js: bytes('.js'), css: bytes('.css') };
    });
    record('coldLoad', 'shellMs', result.shell); record('coldLoad', 'contentMs', result.content);
    record('coldLoad', 'criticalJsKB', result.js / 1024); record('coldLoad', 'criticalCssKB', result.css / 1024);
    log(`cold load ${round + 1}/${rounds}: shell ${result.shell.toFixed(0)} ms, content ${result.content.toFixed(0)} ms`);
    await context.close();
  }
}

// Populates IndexedDB and installs the service worker, like a returning user.
async function prime(browser: Browser, url: string) {
  const context = await newContext(browser, url); const page = await context.newPage();
  await load(page, ''); await quiet(page, 3000);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30000 });
  await page.close(); return context;
}

// A returning user: library cached and service worker installed but not running,
// as after closing the app for a while.
async function warmLoad(context: BrowserContext, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    const { page, cdp } = await openPage(context);
    await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); await cdp.send('ServiceWorker.disable');
    const profiling = await startProfile(cdp, 'warmLoad');
    await load(page); await quiet(page, 1500);
    const cpu = await cpuMetrics(cdp); await stopProfile(cdp, 'warmLoad', profiling);
    const result = await page.evaluate(() => {
      const P = window.__perf; const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime;
      return { ...P.marks, fcp, settle: P.lastActivity, blocking: P.loaf.reduce((t: number, f: any) => t + f.blocking, 0), idb: P.idbWrites, requests: Object.values(P.requests).reduce((t: number, n: any) => t + n, 0) as number, swControlled: !!navigator.serviceWorker.controller };
    });
    if (!result.swControlled) throw new Error('Warm load was not served by the service worker.');
    record('warmLoad', 'fcpMs', result.fcp); record('warmLoad', 'shellMs', result.shell); record('warmLoad', 'contentMs', result.content);
    record('warmLoad', 'settledMs', result.settle); record('warmLoad', 'blockingMs', result.blocking); record('warmLoad', 'cpuMs', cpu.TaskDuration * 1000);
    record('warmLoad', 'heapMB', cpu.JSHeapUsedSize / 1048576); record('warmLoad', 'idbWrites', result.idb); record('warmLoad', 'requests', result.requests);
    log(`warm load ${round + 1}/${rounds}: content ${result.content.toFixed(0)} ms, settled ${result.settle.toFixed(0)} ms, cpu ${(cpu.TaskDuration * 1000).toFixed(0)} ms`);
    await page.close();
  }
}

// Menu opening and document switching, driven the way a person does it.
async function navigation(context: BrowserContext, rounds: number) {
  const openMenu = (page: Page) => page.evaluate(() => {
    const start = performance.now(); document.querySelector<HTMLButtonElement>('#menu-button')!.click();
    return window.__perf.painted(() => document.querySelector<HTMLDialogElement>('#navigation')!.open && document.querySelector('.doc-row')).then((t: number) => t - start);
  });
  // Waits for a different editor element: a new one, or one kept from an earlier visit.
  const open = (page: Page, id: string, title: string) => page.evaluate(({ id, title }) => {
    const previous = document.querySelector<HTMLElement>('.ProseMirror');
    const start = performance.now(); document.querySelector<HTMLButtonElement>(`.doc-row[data-id="${id}"]`)!.click();
    return window.__perf.painted(() => { const editor = document.querySelector<HTMLElement>('.ProseMirror'); return document.querySelector<HTMLInputElement>('#document-title')!.value === title && editor && editor !== previous && editor.textContent; }).then((t: number) => t - start);
  }, { id, title });
  for (let round = 0; round < rounds; round++) {
    const { page } = await openPage(context); await load(page); await quiet(page, 1500);
    const first = Array.from({ length: 8 }, (_, i) => 20 + round * 8 + i);
    for (const i of first) { record('navigation', 'menuOpenMs', await openMenu(page)); record('navigation', 'firstOpenMs', await open(page, docId(i), docTitle(i))); await quiet(page, 1000); }
    for (const i of [...first.slice(4), ...first.slice(4)]) { await openMenu(page); record('navigation', 'reopenMs', await open(page, docId(i), docTitle(i))); await quiet(page, 1000); }
    await openMenu(page); record('navigation', 'largeFirstOpenMs', await open(page, LARGE_ID, 'Perf large document')); await quiet(page, 1000);
    for (let i = 0; i < 2; i++) {
      await openMenu(page); await open(page, docId(first[7]), docTitle(first[7])); await quiet(page, 1000);
      await openMenu(page); record('navigation', 'largeReopenMs', await open(page, LARGE_ID, 'Perf large document')); await quiet(page, 1000);
    }
    log(`navigation ${round + 1}/${rounds}: first open median ${quantile(samples.navigation.firstOpenMs, 0.5).toFixed(0)} ms`);
    await page.close();
  }
}

async function search(context: BrowserContext, rounds: number) {
  const { page } = await openPage(context); await load(page); await quiet(page, 1500);
  await page.locator('#menu-button').click(); await page.locator('.doc-row').first().waitFor();
  const query = (value: string) => page.evaluate(value => {
    const input = document.querySelector<HTMLInputElement>('#search')!; const start = performance.now();
    input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
    return window.__perf.painted(() => document.querySelector('#list-label')!.textContent === 'SEARCH RESULTS' && document.querySelectorAll('.doc-row').length === Number(document.querySelector('#doc-count')!.textContent)).then((t: number) => t - start);
  }, value);
  const clear = () => page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#search')!; input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    return window.__perf.painted(() => document.querySelector('#list-label')!.textContent === 'YOUR DOCUMENTS' && document.querySelectorAll('.doc-row').length > 1);
  });
  for (let i = 0; i < rounds; i++) {
    record('search', 'narrowMs', await query(docTitle(i + 1))); await clear();
    record('search', 'broadMs', await query('shared notebook')); await clear();
  }
  await page.close();
}

const SENTENCES = ['Fast notes should feel instant under every keystroke.', 'The draft grows while sync runs quietly behind it.', 'Short words, long words, and pauses between thoughts.', 'Nothing here should wait on the network or storage.'];
// Types in bursts at `interval` ms per key with a pause after each sentence, so
// idle-time work (autosave, sync, preference writes) overlaps later typing.
async function typeSession(page: Page, cdp: CDPSession, sentences: number, finished = async () => {}, interval = 70, pause = 1200) {
  await page.evaluate(() => { const P = window.__perf; Object.assign(P, { keys: [], requests: {}, idbWrites: 0, recordStart: performance.now(), recording: true }); });
  const cpu: number[] = []; const start = await cpuMetrics(cdp); let before = start; let keys = 0;
  for (let s = 0; s < sentences; s++) {
    const text = `${SENTENCES[s % SENTENCES.length]} `; const begin = Date.now();
    for (let i = 0; i < text.length; i++) { await page.keyboard.type(text[i]); keys++; const wait = begin + (i + 1) * interval - Date.now(); if (wait > 0) await sleep(wait); }
    if (s % 3 === 2) { await page.keyboard.press('Enter'); keys++; }
    await sleep(pause);
    const after = await cpuMetrics(cdp); cpu.push((after.TaskDuration - before.TaskDuration) * 1000); before = after;
  }
  await finished(); await quiet(page, 1500);
  const end = await cpuMetrics(cdp); const spent = (name: string) => (end[name] - start[name]) * 1000;
  const time = { script: spent('ScriptDuration'), layout: spent('LayoutDuration'), style: spent('RecalcStyleDuration'), task: spent('TaskDuration') };
  const data = await page.evaluate(() => { const P = window.__perf; P.recording = false; return { keys: P.keys, loaf: P.loaf.filter((f: any) => f.start >= P.recordStart), requests: P.requests, idbWrites: P.idbWrites }; });
  return { ...data, cpu, time, typed: keys };
}
function recordTyping(scenario: string, result: Awaited<ReturnType<typeof typeSession>>) {
  record(scenario, 'keyToPaintMs', ...result.keys.map((k: any) => k.paint)); record(scenario, 'inputDelayMs', ...result.keys.map((k: any) => k.delay));
  record(scenario, 'cpuPerSentenceMs', ...result.cpu);
  record(scenario, 'scriptPerKeyMs', result.time.script / result.typed); record(scenario, 'layoutPerKeyMs', result.time.layout / result.typed); record(scenario, 'stylePerKeyMs', result.time.style / result.typed);
  record(scenario, 'longFrames', result.loaf.length); record(scenario, 'blockingMs', result.loaf.reduce((t: number, f: any) => t + f.blocking, 0));
  record(scenario, 'requests', Object.values(result.requests as Record<string, number>).reduce((t, n) => t + n, 0)); record(scenario, 'idbWrites', result.idbWrites);
  (details[scenario] ??= []).push({ requests: result.requests, typed: result.typed, measured: result.keys.length });
  log(`${scenario}: per key script ${(result.time.script / result.typed).toFixed(1)} ms, layout ${(result.time.layout / result.typed).toFixed(1)} ms, style ${(result.time.style / result.typed).toFixed(1)} ms, all tasks ${(result.time.task / result.typed).toFixed(1)} ms`);
  log(`${scenario}: key-to-paint p50 ${quantile(result.keys.map((k: any) => k.paint), 0.5).toFixed(1)} / p95 ${quantile(result.keys.map((k: any) => k.paint), 0.95).toFixed(1)} ms, ${result.loaf.length} long frames, requests ${JSON.stringify(result.requests)}`);
}
async function typing(context: BrowserContext, scenario: string, id: string, sessions: number, sentences: number, place: (page: Page) => Promise<void>) {
  for (let session = 0; session < sessions; session++) {
    const { page, cdp } = await openPage(context); await load(page, id); await quiet(page, 1500);
    await place(page); await quiet(page, 1500);
    const profiling = await startProfile(cdp, scenario); const result = await typeSession(page, cdp, sentences); await stopProfile(cdp, scenario, profiling);
    recordTyping(scenario, result);
    await page.close();
  }
}

// A second person edits the same document from Node while the browser user types.
async function collaborator(url: string, name: string) {
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER.username, password: USER.password }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]; const { csrf } = await login.json();
  class CookieSocket extends WebSocket { constructor(address: string, protocols?: string | string[]) { super(address, protocols, { headers: { cookie } }); } }
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: `${url.replace(/^http/, 'ws')}/collaboration`, WebSocketPolyfill: CookieSocket });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name, document: doc, token: csrf });
  provider.attach();
  await new Promise<void>(resolve => { if (provider.isSynced) resolve(); else provider.on('synced', () => resolve()); });
  provider.setAwarenessField('user', { name: 'Remote collaborator', color: '#ab6f47' });
  const text = (doc.getXmlFragment('default').get(1) as Y.XmlElement).get(0) as Y.XmlText;
  const sent: [number, number][] = []; let timer: ReturnType<typeof setInterval> | undefined;
  return {
    initialLength: text.length,
    start(every = 150) {
      timer = setInterval(() => {
        text.insert(text.length, 'y'); sent.push([text.length, Date.now()]);
        const at = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, text.length));
        provider.setAwarenessField('cursor', { anchor: at, head: at });
      }, every);
    },
    stop() { clearInterval(timer); },
    sent,
    destroy() { provider.destroy(); socket.destroy(); doc.destroy(); },
  };
}
async function collaboration(context: BrowserContext, url: string, sentences: number) {
  const id = docId(60); const bot = await collaborator(url, id);
  try {
    const { page, cdp } = await openPage(context); await load(page, id); await quiet(page, 1500);
    await page.evaluate(() => {
      const editor = document.querySelector('.ProseMirror')!; const P = window.__perf; let last = 0;
      new MutationObserver(() => {
        // Ignore the collaborator's caret and name label, which render inside the paragraph.
        const paragraph = editor.children[1]; const caret = paragraph?.querySelector('.collaboration-carets__caret');
        const length = (paragraph?.textContent?.length || 0) - (caret?.textContent?.length || 0); if (length <= last) return; last = length;
        requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => P.seen.push([length, Date.now()]); channel.port2.postMessage(0); });
      }).observe(editor, { childList: true, subtree: true, characterData: true });
    });
    await page.locator('.ProseMirror').click(); await page.keyboard.press('Control+End'); await quiet(page, 1000);
    const profiling = await startProfile(cdp, 'collaboration'); bot.start();
    const result = await typeSession(page, cdp, sentences, async () => bot.stop()); await stopProfile(cdp, 'collaboration', profiling);
    recordTyping('collaboration', result);
    const seen: [number, number][] = await page.evaluate(() => window.__perf.seen);
    const latencies = bot.sent.map(([length, at]) => { const hit = seen.find(([l]) => l >= length); return hit ? hit[1] - at : NaN; }).filter(Number.isFinite);
    if (latencies.some(ms => ms < 0)) throw new Error('A remote edit appeared before it was sent; the paragraph length measurement is wrong.');
    if (latencies.length < bot.sent.length * 0.9) throw new Error(`Only ${latencies.length} of ${bot.sent.length} remote edits appeared in the browser.`);
    record('collaboration', 'remoteToPaintMs', ...latencies);
    log(`collaboration: remote edit to paint p50 ${quantile(latencies, 0.5).toFixed(0)} ms, p95 ${quantile(latencies, 0.95).toFixed(0)} ms`);
    await page.close();
  } finally { bot.destroy(); }
}

const scratch = await mkdtemp(path.join(tmpdir(), 'garnet-perf-'));
let target = { buildDir: path.resolve(options.build!), commit: '', cleanup: () => {} };
let mongo: Awaited<ReturnType<typeof startMongo>> | undefined; let server: Awaited<ReturnType<typeof startServer>> | undefined; let browser: Browser | undefined;
try {
  if (options.ref) { log(`building ${options.ref} in a temporary worktree`); target = await buildRef(options.ref, scratch); }
  else target.commit = `${execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim()}${execFileSync('git', ['status', '--porcelain']).toString().trim() ? '+changes' : ''}`;
  const label = options.label || target.commit;
  log(`measuring ${target.buildDir} (${target.commit}) at ${cpuRate}x CPU slowdown with ${documentCount} documents`);
  mongo = await startMongo(scratch, options.mongo);
  const content = await seed(mongo.uri, documentCount);
  server = await startServer(target.buildDir, mongo.uri, scratch);
  browser = await chromium.launch({ channel: 'chromium', headless: !options.headed });
  const rounds = (normal: number) => quick ? Math.max(1, Math.ceil(normal / 3)) : normal;
  if (enabled('bundle')) await bundle(target.buildDir);
  if (enabled('coldLoad')) await coldLoad(browser, server.url, rounds(2));
  const context = await prime(browser, server.url); log('library cached and service worker installed');
  if (enabled('warmLoad')) await warmLoad(context, rounds(8));
  if (enabled('navigation')) await navigation(context, rounds(3));
  if (enabled('search')) await search(context, rounds(12));
  if (enabled('typing')) await typing(context, 'typing', docId(10), rounds(2), 8, async page => { await page.locator('.ProseMirror').click(); await page.keyboard.press('Control+End'); });
  if (enabled('typingLarge')) await typing(context, 'typingLarge', LARGE_ID, rounds(2), 8, async page => { await page.locator('.ProseMirror p').nth(500).click(); await page.keyboard.press('End'); });
  if (enabled('collaboration')) await collaboration(context, server.url, quick ? 3 : 8);
  const result = {
    label, commit: target.commit, build: target.buildDir, date: new Date().toISOString(), cpuSlowdown: cpuRate, profiled: options.profile, browser: browser.version(),
    machine: { cpu: cpus()[0]?.model, cores: cpus().length, platform: process.platform }, documents: documentCount, content, quick,
    summary: Object.fromEntries(Object.entries(samples).map(([scenario, metrics]) => [scenario, Object.fromEntries(Object.entries(metrics).map(([name, values]) => [name, summary(values)]))])),
    samples, details,
  };
  const out = options.out || `perf-results/${label.replace(/[^\w.-]+/g, '-')}.json`;
  await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(result, null, 2));
  for (const [scenario, metrics] of Object.entries(result.summary)) { console.log(`\n${scenario}`); console.table(metrics); }
  log(`wrote ${out}`);
} finally {
  await browser?.close(); await server?.stop(); await mongo?.stop(); target.cleanup();
  if (!options.keep) await rm(scratch, { recursive: true, force: true }); else log(`kept ${scratch}`);
}
