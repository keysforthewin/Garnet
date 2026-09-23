import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupPath } from '../scripts/shell-path.mjs';

for (const shell of ['bash', 'zsh', 'fish']) test(`${shell} PATH setup is repeatable`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'garnet-path-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = await setupPath({ home, shell, envPath: '' });
  const original = await readFile(first.file, 'utf8');
  assert.equal(first.changed, true);
  const again = await setupPath({ home, shell, envPath: '' });
  assert.equal(again.changed, false);
  assert.equal(await readFile(first.file, 'utf8'), original);
});
test('PATH is added beside the existing assignment and existing entries stay unchanged', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'garnet-path-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, '.zprofile');
  await writeFile(file, 'export PATH="$HOME/bin:$PATH"\n# keep this\n');
  assert.equal((await setupPath({ home, shell: 'zsh' })).file, file);
  assert.match(await readFile(file, 'utf8'), /export PATH=.*\ncase .*\n# keep this/);
  await writeFile(file, 'export PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal((await setupPath({ home, shell: 'zsh' })).changed, false);
  assert.equal(await readFile(file, 'utf8'), 'export PATH="$HOME/.local/bin:$PATH"\n');
});
