import { execFileSync } from 'node:child_process';
export default function teardown() { execFileSync(process.execPath, ['scripts/test-app.mjs', 'stop'], { stdio: 'inherit' }); }
