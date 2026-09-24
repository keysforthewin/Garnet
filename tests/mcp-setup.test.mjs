import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { setup, remove, entry, installation, matches } from '../packages/garnet-mcp/setup.mjs';
const require = createRequire(import.meta.url);

test('setup prompts separately, preserves settings, is repeatable, and removes only its own entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'garnet-setup-test-'));
  const previous = { ...process.env };
  const bin = path.join(dir, 'bin'); const runtime = path.join(dir, 'runtime');
  for (const sub of [bin, runtime, path.join(dir, 'claude'), path.join(dir, 'codex')]) await mkdir(sub);
  process.env.PATH = bin; process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude'); process.env.CODEX_HOME = path.join(dir, 'codex');
  const fake = `#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const {parse,stringify} = await import(${JSON.stringify(require.resolve('smol-toml'))});
const agent=path.basename(process.argv[1]); const args=process.argv.slice(2);
const file=agent==='claude'?path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json'):path.join(process.env.CODEX_HOME,'config.toml');
const data=agent==='claude'?JSON.parse(readFileSync(file,'utf8')):parse(readFileSync(file,'utf8'));
const key=agent==='claude'?'mcpServers':'mcp_servers'; data[key] ||= {};
if(args[1]==='remove') delete data[key].garnet;
else { const index=args.indexOf('--'); data[key].garnet={command:args[index+1],args:args.slice(index+2)}; }
writeFileSync(file,agent==='claude'?JSON.stringify(data,null,2):stringify(data));
`;
  for (const agent of ['claude', 'codex']) await writeFile(path.join(bin, agent), fake, { mode: 0o755 });
  await writeFile(path.join(dir, 'claude/.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }));
  await writeFile(path.join(dir, 'codex/config.toml'), 'model="custom"\n[mcp_servers.other]\ncommand="other"\n');
  const server = createServer(async (req, res) => { for await (const _ of req) {} res.setHeader('content-type', 'application/json'); res.end('[]'); });
  await new Promise(resolve => server.listen(path.join(runtime, 'app.sock'), resolve));
  const target = { runtime, command: process.execPath, args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('runner/tools.ts'), '--socket', path.join(runtime, 'app.sock'), '--credential-file', path.join(runtime, 'mcp-token')] };
  const quiet = () => {};
  try {
    const questions = [];
    await setup(target, { ask: async q => { questions.push(q); return q.includes('Claude'); }, log: quiet });
    assert.equal(questions.length, 2); assert.ok(matches(await entry('claude'), target)); assert.equal(await entry('codex'), undefined);
    await writeFile(path.join(dir, 'codex/config.toml'), 'model="custom"\n[mcp_servers.other]\ncommand="other"\n[mcp_servers.garnet]\ncommand="legacy"\n');
    await setup(target, { agents: ['codex'], log: quiet });
    assert.equal((await entry('codex')).command, 'legacy');
    await setup(target, { agents: ['claude', 'codex'], replace: true, log: quiet });
    const claudeBefore = await readFile(path.join(dir, 'claude/.claude.json'), 'utf8');
    const codexBefore = await readFile(path.join(dir, 'codex/config.toml'), 'utf8');
    await setup(target, { agents: ['claude', 'codex'], log: quiet });
    assert.equal(await readFile(path.join(dir, 'claude/.claude.json'), 'utf8'), claudeBefore);
    assert.equal(await readFile(path.join(dir, 'codex/config.toml'), 'utf8'), codexBefore);
    assert.match(codexBefore, /custom/); assert.equal(JSON.parse(claudeBefore).theme, 'dark');
    assert.ok((await readdir(path.join(dir, 'claude'))).some(p => p.includes('garnet-backup')));
    assert.ok(matches(await entry('codex'), target));
    // A user-edited entry no longer belongs to setup and must survive removal.
    const changed = JSON.parse(claudeBefore); changed.mcpServers.garnet.command = 'custom-garnet';
    await writeFile(path.join(dir, 'claude/.claude.json'), JSON.stringify(changed));
    await setup(target, { agents: ['manual'], log: quiet });
    await remove(target, { agents: ['claude', 'codex'], log: quiet });
    assert.ok(await readFile(path.join(runtime, 'mcp-token'), 'utf8'));
    await remove(target, { agents: ['manual'], log: quiet });
    assert.equal((await entry('claude')).command, 'custom-garnet'); assert.equal(await entry('codex'), undefined);
    await assert.rejects(readFile(path.join(runtime, 'mcp-token')), { code: 'ENOENT' });
    assert.match(await readFile(path.join(dir, 'codex/config.toml'), 'utf8'), /other/);
  } finally { process.env = previous; await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('source discovery uses its own stable launcher and missing installs are actionable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garnet-source-test-'));
  try {
    await assert.rejects(installation(root), /Install Garnet first/);
    await mkdir(path.join(root, 'data/runtime'), { recursive: true }); await mkdir(path.join(root, 'build'));
    await writeFile(path.join(root, 'data/runtime/source-install.json'), '{}');
    await writeFile(path.join(root, 'build/tools.mjs'), ''); await writeFile(path.join(root, 'garnet'), '', { mode: 0o755 });
    assert.deepEqual((await installation(root)).args, ['mcp', `--root=${root}`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interactive setup closes its real terminal after both consent questions', { timeout: 10000 }, async t => {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const code = `import {terminalPrompt} from './packages/garnet-mcp/setup.mjs';
    const p=await terminalPrompt();
    if(!await p.ask('Claude probe?'))process.exitCode=1;
    if(!await p.ask('Codex probe?'))process.exitCode=1;
    await p.close(); console.log('Terminal closed successfully');`;
  const child = spawn('script', ['-qefc', `${quote(process.execPath)} --input-type=module -e ${quote(code)}`, '/dev/null']);
  t.after(() => child.kill('SIGKILL'));
  let output = ''; const answered = new Set();
  child.stdout.on('data', chunk => {
    output += chunk;
    for (const name of ['Claude', 'Codex']) if (output.includes(`${name} probe?`) && !answered.has(name)) { answered.add(name); child.stdin.write('y\n'); }
  });
  child.stderr.on('data', chunk => output += chunk);
  const codeResult = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  assert.equal(codeResult, 0, output);
  assert.match(output, /Terminal closed successfully/);
  assert.equal(answered.size, 2);
});
