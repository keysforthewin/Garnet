// Redraws the PNG and ICO icons in public/ from public/favicon.svg. Run after changing the SVG.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
const svg = await readFile('public/favicon.svg', 'utf8');
// Home screens cut their own corners, and fill what is transparent with black: those icons run to the edge.
const square = svg.replace(/<clipPath.*?<\/clipPath>/, '').replace(' clip-path="url(#c)"', '');
if (square === svg) throw new Error('public/favicon.svg no longer has the corner clip this script removes.');
const browser = await chromium.launch();
const png = async (source, size) => {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
  const data = await page.screenshot({ omitBackground: true }); await page.close(); return data;
};
await writeFile('public/icon-192.png', await png(svg, 192));
await writeFile('public/icon-512.png', await png(svg, 512));
await writeFile('public/icon-maskable-512.png', await png(square, 512));
await writeFile('public/apple-touch-icon.png', await png(square, 180));
// An ICO file may hold PNG images as they are: a six-byte header, sixteen bytes naming each, then the images.
const sizes = [16, 32, 48]; const images = await Promise.all(sizes.map(size => png(svg, size)));
const header = Buffer.alloc(6 + 16 * sizes.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => { const at = 6 + 16 * index; header.writeUInt8(size, at); header.writeUInt8(size, at + 1); header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(images[index].length, at + 8); header.writeUInt32LE(offset, at + 12); offset += images[index].length; });
await writeFile('public/favicon.ico', Buffer.concat([header, ...images]));
await browser.close();
