import { build as bundle } from 'esbuild';
import { build as vite } from 'vite';
import { mkdir, writeFile, readdir, readFile, copyFile, rm } from 'node:fs/promises';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
await mkdir('build', { recursive: true });
await rm('build/runner.mjs', { force: true });
await rm('build/runner.mjs.map', { force: true });
await vite();
await bundle({ entryPoints: ['server/index.ts'], outfile: 'build/server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true });
await bundle({ entryPoints: ['server/document-extractor.ts'], outfile: 'build/document-extractor.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true });
await bundle({ entryPoints: ['runner/tools.ts'], outfile: 'build/tools.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22' });
const assets = (await readdir('build/public/assets')).map(file => `/assets/${file}`);
const version = assets.filter(file => file.endsWith('.js')).join('|');
const cacheName = `garnet-shell-${gzipSync(version).toString('hex').slice(-24)}`;
// The worker installs from the network, never the browser's copy: an error cached there (as a proxy may do) would fail every install.
await writeFile('build/public/sw.js', `const CACHE=${JSON.stringify(cacheName)};const ASSETS=${JSON.stringify(['/', '/index.html', '/manifest.webmanifest', ...assets])};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(url=>new Request(url,{cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([self.registration.navigationPreload?.enable(),caches.keys().then(keys=>Promise.all(keys.filter(key=>(key.startsWith('ed-shell-')||key.startsWith('garnet-shell-'))&&key!==CACHE).map(key=>caches.delete(key))))]).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname==='/collaboration')return;if(event.request.mode==='navigate'){event.respondWith(Promise.resolve(event.preloadResponse).then(preloaded=>preloaded||fetch(event.request)).catch(()=>caches.match('/index.html')));return;}event.respondWith(caches.open(CACHE).then(cache=>cache.match(event.request)).then(cached=>cached||fetch(event.request)));});`);
await writeFile('build/public/manifest.webmanifest', JSON.stringify({ name: 'Garnet', short_name: 'Garnet', start_url: '/', display: 'standalone', background_color: '#fdfdfb', theme_color: '#f5f5f1', icons: [] }));
await copyFile('package.json', 'build/package.json');
await copyFile('package-lock.json', 'build/package-lock.json');
// Maximum-effort Brotli and gzip copies, which the server sends instead of compressing each request.
const sizes = [];
for (const file of assets) {
  const data = await readFile(`build/public${file}`); const gzip = gzipSync(data, { level: 9 });
  await writeFile(`build/public${file}.br`, brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }));
  await writeFile(`build/public${file}.gz`, gzip);
  if (file.endsWith('.js')) sizes.push({ file, gzipBytes: gzip.length });
}
await writeFile('build/bundle-sizes.json', JSON.stringify(sizes, null, 2));
console.log('Gzipped JavaScript:', sizes);
