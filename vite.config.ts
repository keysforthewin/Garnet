import { defineConfig } from 'vite';
export default defineConfig({ build: { outDir: 'build/public', emptyOutDir: true, target: 'es2022' }, server: { proxy: { '/api': 'http://127.0.0.1:7777', '/collaboration': { target: 'ws://127.0.0.1:7777', ws: true } } } });
