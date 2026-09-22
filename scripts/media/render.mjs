import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { videos } from './storyboards.mjs';

const raw = path.resolve('test-results/media');
const output = path.resolve('docs/media/garnet');
await mkdir(output, { recursive: true });
const capture = JSON.parse(await readFile(path.join(raw, 'capture.json'), 'utf8'));
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error = (error + data).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${error}`)));
  });
}
const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
function artwork(video, shot, number) {
  const dark = video.theme === 'dark';
  const ink = dark ? '#f5f5e9' : '#283526';
  const accent = dark ? '#c3e594' : '#526743';
  const paper = dark ? '#253326' : '#f5f5ed';
  const dim = dark ? '#b5c2aa' : '#697261';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:1080px;height:1080px;background:transparent;color:${ink};font-family:'Ubuntu Sans',Arial,sans-serif}
    .top{position:absolute;left:64px;right:64px;top:44px;display:flex;align-items:center;justify-content:space-between}
    .brand{font-size:36px;letter-spacing:-1.6px;font-weight:760}.edition{font:500 19px 'Ubuntu Mono',monospace;letter-spacing:2px;color:${dim}}
    .headline{position:absolute;top:115px;left:64px;right:52px;font-size:${shot.size || 76}px;line-height:1.02;letter-spacing:-3px;font-weight:760;white-space:pre-line;margin:0}
    .frame{position:absolute;left:46px;top:284px;width:988px;height:638px;border:2px solid ${dark ? '#64795b' : '#ced4c5'};border-radius:3px;box-shadow:0 12px 24px #14230d12}
    .points{position:absolute;left:64px;top:946px;font-size:${shot.bulletSize || 36}px;line-height:1.32;letter-spacing:-.55px;color:${ink}}
    .point{display:flex;gap:18px;align-items:center}.dot{width:8px;height:8px;border-radius:50%;background:${accent};flex:none}
    .wait{position:absolute;right:68px;top:888px;padding:4px 12px;background:${paper};color:${dim};font-size:19px;letter-spacing:.2px}
    .footerline{position:absolute;bottom:25px;left:64px;right:64px;height:2px;background:${dark ? '#465640' : '#d9dfce'}}
    .end{position:absolute;inset:0;background:${paper};padding:64px}
    .end .bigbrand{font-size:166px;font-weight:780;letter-spacing:-10px;margin:134px 0 18px;line-height:1}
    .end .tag{font-size:78px;font-weight:680;letter-spacing:-3px;line-height:1.05;margin:55px 0 58px}
    .pill{display:inline-block;border:2px solid ${accent};border-radius:40px;padding:12px 24px;font-size:30px;margin:0 12px 12px 0;color:${ink}}
    .url{position:absolute;left:64px;bottom:120px;font-size:36px;letter-spacing:-.8px}
    .arrow{position:absolute;right:74px;top:227px;color:${accent};font-size:138px;line-height:1}
    .end .eyebrow{font:500 21px 'Ubuntu Mono',monospace;letter-spacing:2px;color:${dim}}
  </style></head><body>${shot.end ? `<div class="end"><div class="eyebrow">SMALL APP. BIG POSSIBILITIES.</div><div class="bigbrand">Garnet</div><div class="arrow">↗</div><div class="tag">Make room for<br>your next idea.</div><span class="pill">Free</span><span class="pill">Open source</span><span class="pill">MIT licensed</span><div class="url">github.com/keysforthewin/Garnet</div></div>` : `<div class="top"><div class="brand">Garnet<span style="color:${accent}"> /</span></div><div class="edition">0${number + 1} — ${video.label}</div></div><h1 class="headline">${esc(shot.title)}</h1><div class="frame"></div><div class="points">${shot.bullets.map(point => `<div class="point"><span class="dot"></span>${esc(point)}</div>`).join('')}</div>${shot.shortened ? '<div class="wait">Real agent run · Wait shortened</div>' : ''}`}<div class="footerline"></div></body></html>`;
}

const transcript = ['# Garnet launch videos', '', 'Three square, silent, 30-second demos. Real application footage; agent waiting is shortened and labeled. Garnet is free MIT-licensed software; agent usage relies on your existing CLI accounts.', ''];
try {
  for (const [number, video] of videos.entries()) {
    const dir = path.join(raw, video.id);
    await mkdir(dir, { recursive: true });
    const parts = [];
    let time = 0;
    transcript.push(`## ${video.title}`, '', `File: [${video.id}.mp4](${video.id}.mp4)`, '', '**X post**', '', video.post, '', '| Time | Overlay | Supporting points |', '| --- | --- | --- |');
    for (const [index, shot] of video.shots.entries()) {
      const png = path.join(dir, `${index}.png`);
      await page.setContent(artwork(video, shot, number));
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => [...document.querySelectorAll('.headline,.point,.url,.tag')].some(el => el.getBoundingClientRect().right > 1032 || el.scrollWidth > el.clientWidth + 1));
      if (overflow) throw new Error(`Text overflow in ${video.id} shot ${index}`);
      await page.screenshot({ path: png, omitBackground: true });
      const mp4 = path.join(dir, `${index}.mp4`);
      const bg = video.theme === 'dark' ? '0x253326' : '0xf5f5ed';
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_complex_threads', '2', '-f', 'lavfi', '-i', `color=c=${bg}:s=1080x1080:r=30:d=${shot.duration}`];
      let filter;
      if (shot.end) {
        args.push('-loop', '1', '-framerate', '30', '-i', png);
        filter = '[0:v][1:v]overlay=0:0:shortest=1,format=yuv420p[out]';
      } else {
        const source = capture[shot.source];
        if (!source || (shot.offset || 0) + shot.duration > source.seconds + 0.01) throw new Error(`Insufficient footage: ${shot.source}`);
        args.push('-f', 'concat', '-safe', '0', '-i', path.resolve(source.concat), '-loop', '1', '-framerate', '30', '-i', png);
        const crop = shot.crop === 'editor' ? 'crop=928:598:252:69,' : '';
        filter = `[1:v]trim=start=${shot.offset || 0}:duration=${shot.duration},setpts=PTS-STARTPTS,${crop}scale=984:634:flags=lanczos,setsar=1,fps=30[screen];[0:v][screen]overlay=48:286:shortest=0[base];[base][2:v]overlay=0:0:shortest=1,format=yuv420p[out]`;
      }
      args.push('-filter_complex', filter, '-map', '[out]', '-an', '-t', String(shot.duration), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '2200k', '-bufsize', '4400k', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', mp4);
      await run('ffmpeg', args);
      parts.push(`file '${path.basename(mp4)}'`);
      transcript.push(`| ${time}–${time + shot.duration}s | ${shot.end ? 'Garnet. Make room for your next idea.' : shot.title.replaceAll('\n', ' ')} | ${shot.end ? 'Free · Open source · MIT licensed · GitHub URL' : shot.bullets.join(' · ')}${shot.shortened ? ' · Wait shortened' : ''} |`);
      time += shot.duration;
      console.log(`Rendered ${video.id} shot ${index + 1}/${video.shots.length}`);
    }
    if (time !== 30) throw new Error(`${video.id} is ${time}s`);
    const list = path.join(dir, 'parts.ffconcat');
    await writeFile(list, parts.join('\n') + '\n');
    const target = path.join(output, `${video.id}.mp4`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', target]);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', target, '-frames:v', '1', path.join(output, `${video.id}-poster.png`)]);
    transcript.push('');
    console.log(`Finished ${target}`);
  }
  await writeFile(path.join(output, 'COPY.md'), transcript.join('\n') + '\n');
} finally { await browser.close(); }
