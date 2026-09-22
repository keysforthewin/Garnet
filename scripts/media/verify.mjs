import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { videos } from './storyboards.mjs';

const output = path.resolve('docs/media/garnet');
await mkdir('test-results/media', { recursive: true });
const results = [];
for (const video of videos) {
  const file = path.join(output, `${video.id}.mp4`);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,width,height,avg_frame_rate,pix_fmt', '-of', 'json', file], { encoding: 'utf8' }));
  const stream = probe.streams[0];
  assert.equal(stream.codec_name, 'h264');
  assert.equal(stream.width, 1080); assert.equal(stream.height, 1080);
  assert.equal(stream.avg_frame_rate, '30/1'); assert.equal(stream.pix_fmt, 'yuv420p');
  assert.equal(probe.streams.length, 1, 'Silent export should contain only the video stream');
  assert.ok(Math.abs(Number(probe.format.duration) - 30) < 0.05);
  assert.ok(Number(probe.format.size) < 9_500_000);
  const bytes = await readFile(file);
  assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')), 'Fast-start metadata must precede video data');
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
  await access(path.join(output, `${video.id}-poster.png`));
  results.push({ file: `${video.id}.mp4`, seconds: Number(probe.format.duration), bytes: Number(probe.format.size), width: 1080, height: 1080, fps: 30, codec: 'h264', decoded: true });
}
for (const name of ['editor', 'collaboration', 'claude', 'codex']) await access(path.join(output, `${name}.png`));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(output, 'index.html')).href);
  await expect(page.locator('video')).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const video = page.locator('video').nth(i);
    await expect.poll(() => video.evaluate(el => el.readyState)).toBeGreaterThanOrEqual(1);
    await video.evaluate(async el => { el.currentTime = 1; await el.play(); });
    await expect.poll(() => video.evaluate(el => el.currentTime)).toBeGreaterThan(1.3);
    await video.evaluate(el => { el.pause(); el.currentTime = 27; });
    await expect.poll(() => video.evaluate(el => !el.seeking && el.readyState >= 2)).toBe(true);
    assert.equal(await video.evaluate(el => el.error), null);
    await video.evaluate(el => { el.currentTime = 0; });
  }
  await page.screenshot({ path: 'test-results/media/player-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'test-results/media/player-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
const readme = await readFile('README.md', 'utf8');
for (const match of readme.matchAll(/(?:\]\(|src=")(docs\/media\/garnet\/[^)"?]+)(?:\?[^)"]*)?[)"]/g)) await access(match[1]);
let capture;
try {
  const evidence = JSON.parse(await readFile('test-results/media/verification.json', 'utf8'));
  assert.equal(evidence.offlineReload, true);
  assert.equal(evidence.reconnected, true);
  assert.equal(evidence.collaboration, 'bidirectional');
  assert.deepEqual(evidence.pageErrors, []);
  assert.deepEqual(evidence.jobs.map(job => job.provider).sort(), ['claude', 'codex']);
  for (const job of evidence.jobs) assert.equal(job.status, 'completed');
  capture = { recorded: evidence.date, offlineReload: true, reconnection: true, bidirectionalCollaboration: true, browserErrors: 0, agents: evidence.jobs.map(({ provider, status, elapsedSeconds }) => ({ provider, status, elapsedSeconds })) };
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(path.join(output, 'verification.json'), JSON.stringify({ verified: new Date().toISOString(), files: results, browserPlayback: true, seekToEndCard: true, mobilePlayerOverflow: false, readmeMediaPaths: true, capture }, null, 2) + '\n');
console.log('Verified three 30-second H.264 videos, complete decoding, browser playback/seeking, mobile layout, and README media paths.');
