import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { updateYFragment, initProseMirrorDoc } from '@tiptap/y-tiptap';
import { schema, parseMarkdown } from '../shared/editor';
const text = Array.from({ length: 125 }, (_, i) => `Paragraph ${i + 1}. A shared notebook keeps ideas close at hand. This is a realistic short paragraph for testing local typing, search, and document navigation.`).join('\n\n');
const doc = new Y.Doc(); const fragment = doc.getXmlFragment('default');
updateYFragment(doc, fragment, schema.nodeFromJSON(parseMarkdown(text)), { mapping: initProseMirrorDoc(fragment, schema).mapping, isOMark: new Map() });
const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
const docs = Array.from({ length: 500 }, (_, i) => ({ _id: `benchmark-${String(i).padStart(4, '0')}`, title: `Benchmark note ${String(i).padStart(4, '0')}`, state, markdown: text, revision: 0, mirrorRevision: -1, createdAt: Date.now() - i * 1000, updatedAt: Date.now() - i * 1000, deletedAt: null, ops: [] }));
execFileSync('docker', ['compose', 'exec', '-T', 'test-app', 'node', '--input-type=module', '-e', 'import {MongoClient} from "mongodb"; let raw=""; for await(const chunk of process.stdin) raw+=chunk; const client=await new MongoClient("mongodb://mongo:27017/ed_test").connect(); const docs=client.db().collection("documents"); await docs.deleteMany({_id:/^benchmark-/}); await docs.insertMany(JSON.parse(raw).map(d=>({...d,state:Buffer.from(d.state,"base64")}))); await client.close();'], { input: JSON.stringify(docs), maxBuffer: 1024 * 1024 });
const browser = await chromium.launch(); const page = await browser.newPage();
await page.addInitScript('window.__name = (fn) => fn');
await page.goto('http://127.0.0.1:8081'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('ed-test-password-2026'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
await page.waitForFunction(() => { const text = document.querySelector('#cache-status')?.textContent || ''; const match = text.match(/(\d+)\/(\d+)/); return match && Number(match[1]) >= 500 && match[1] === match[2]; }, undefined, { timeout: 120000 });
await page.locator('[data-id="benchmark-0000"]').waitFor();
const timings = { cachedOpenMs: [] as number[], typingMs: [] as number[], searchMs: [] as number[] };
for (let i = 0; i < 25; i++) {
  const id = `benchmark-${String(i % 5).padStart(4, '0')}`;
  const duration = await page.evaluate(async id => {
    const start = performance.now(); (document.querySelector(`[data-id="${id}"]`) as HTMLButtonElement).click();
    await new Promise<void>(resolve => { const check = () => document.querySelector<HTMLInputElement>('#document-title')?.value === `Benchmark note ${id.slice(-4)}` && document.querySelector('.prose')?.textContent?.includes('Paragraph 125') ? requestAnimationFrame(() => resolve()) : requestAnimationFrame(check); check(); });
    return performance.now() - start;
  }, id); if (i >= 5) timings.cachedOpenMs.push(duration);
  await page.locator('.prose').click(); await page.keyboard.press('Control+End');
  await page.evaluate(() => { (window as any).edKeyStart = 0; (window as any).edKeyTime = 0; document.addEventListener('keydown', () => { (window as any).edKeyStart = performance.now(); }, { once: true }); document.querySelector('.prose')!.addEventListener('input', () => requestAnimationFrame(() => { (window as any).edKeyTime = performance.now() - (window as any).edKeyStart; }), { once: true }); });
  await page.keyboard.type('x'); await page.waitForFunction(() => (window as any).edKeyTime > 0); timings.typingMs.push(await page.evaluate(() => (window as any).edKeyTime));
  const search = await page.evaluate(async () => { const input = document.querySelector<HTMLInputElement>('#search')!; const start = performance.now(); input.value = 'Benchmark note 0001'; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise<void>(resolve => { const check = () => document.querySelectorAll('.doc-row').length === 1 ? requestAnimationFrame(() => resolve()) : requestAnimationFrame(check); check(); }); return performance.now() - start; }); timings.searchMs.push(search);
  await page.locator('#search').fill(''); await page.waitForFunction(() => document.querySelectorAll('.doc-row').length >= 500);
}
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const result = { documents: 500, bytesPerDocument: Buffer.byteLength(text), browser: await browser.version(), platform: process.platform, p95: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, Number(p95(values).toFixed(1))])), samples: timings };
await mkdir('test-results', { recursive: true }); await writeFile('test-results/benchmark.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, samples: undefined }, null, 2)); await browser.close();
if (result.p95.cachedOpenMs > 100 || result.p95.typingMs > 50 || result.p95.searchMs > 100) process.exitCode = 1;
