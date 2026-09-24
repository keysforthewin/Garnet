import { access, readFile, writeFile, mkdir, rename, copyFile, rm, open, lstat } from 'node:fs/promises';
import { constants, openSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'smol-toml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const optional = async (file, fallback) => { try { return await json(file); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
export async function atomicJSON(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export async function installation(root = process.env.GARNET_HOME || path.join(os.homedir(), '.local/share/garnet')) {
  root = path.resolve(root);
  const config = await optional(path.join(root, 'install.json'), null);
  const source = !config && await optional(path.join(root, 'data/runtime/source-install.json'), null);
  if (!config && !source) throw Error('Garnet installation not found. Install Garnet first, or pass --root=/path/to/garnet.');
  const release = config ? path.join(root, 'current') : root;
  const data = config?.data || path.join(root, 'data');
  const command = config ? path.join(os.homedir(), '.local/bin/garnet') : path.join(root, 'garnet');
  await access(path.join(release, 'build/tools.mjs'));
  await access(command, constants.X_OK);
  return { root, data, runtime: path.join(data, 'runtime'), release, command, args: ['mcp', `--root=${root}`] };
}
export async function executable(name) {
  for (const directory of [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin')].filter(Boolean)) {
    const candidate = path.resolve(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
}
export function configPath(agent) {
  if (agent === 'codex') return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}
export async function entry(agent, file = configPath(agent)) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  return agent === 'codex' ? parse(raw).mcp_servers?.garnet : JSON.parse(raw).mcpServers?.garnet;
}
export function matches(actual, target) {
  return actual?.command === target.command && JSON.stringify(actual?.args || []) === JSON.stringify(target.args) && !actual?.url && (!actual?.type || actual.type === 'stdio');
}
async function backup(file) {
  try {
    const copy = `${file}.garnet-backup-${Date.now()}-${randomUUID()}`;
    await copyFile(file, copy, constants.COPYFILE_EXCL);
    const handle = await open(copy, 'r+'); await handle.chmod(0o600); await handle.close();
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
}
export async function terminalPrompt() {
  let input, output;
  try {
    // TTY streams can cancel pending reads and let readline control echo/raw mode.
    // fs streams cannot safely close a blocking /dev/tty read after a question.
    input = new ReadStream(openSync('/dev/tty', 'r'));
    output = new WriteStream(openSync('/dev/tty', 'w'));
  } catch { input?.destroy(); return { ask: async () => false, close: async () => {} }; }
  const rl = createInterface({ input, output, terminal: true });
  return {
    ask: async question => /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()),
    close: async () => {
      rl.close(); input.destroy();
      // Flush readline's final terminal writes before destroying the output.
      await new Promise(resolve => output.write('', () => { output.destroy(); resolve(); }));
    },
  };
}

export async function credential(runtime) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const file = path.join(runtime, 'mcp-token');
  try { await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^[a-f0-9]{64}\n?$/.test(await readFile(file, 'utf8'))) throw Error('Unsafe Garnet MCP credential file. It must be an owner-only regular file.');
}
export async function doctor(target, log = console.log) {
  const client = new Client({ name: 'garnet-setup', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: target.command, args: target.args, stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 10000 });
    const { tools } = await client.listTools();
    for (const name of ['list_documents', 'search_documents', 'read_document', 'create_document', 'edit_document']) if (!tools.some(t => t.name === name)) throw Error(`Missing Garnet tool: ${name}`);
    const result = await client.callTool({ name: 'list_documents', arguments: {} }, undefined, { timeout: 10000 });
    if (result.isError) throw Error(result.content?.[0]?.text || 'Garnet access failed');
    log('Garnet MCP is ready: backend access and all five tools verified.');
  } finally { await client.close(); }
}
export async function setup(target, { agents = [], replace = false, ask = async () => false, log = console.log } = {}) {
  const trackingFile = path.join(target.runtime, 'mcp-install.json');
  const tracking = await optional(trackingFile, { entries: [] });
  let selected = 0;
  if (agents.includes('manual')) {
    await credential(target.runtime); await doctor(target, log);
    tracking.manual = true; await atomicJSON(trackingFile, tracking); selected++;
    log(JSON.stringify({ mcpServers: { garnet: { command: target.command, args: target.args } } }, null, 2));
  }
  for (const agent of ['claude', 'codex']) {
    if (agents.length && !agents.includes(agent)) continue;
    const command = await executable(agent); const file = configPath(agent);
    if (!command) { log(`${agent} not found. Install it, then rerun npx garnet-mcp setup.`); continue; }
    log(`${agent === 'claude' ? 'Claude Code' : 'Codex'} found at ${command}. Configuration: ${file}`);
    if (!agents.includes(agent) && !await ask(`Add Garnet to ${agent === 'claude' ? 'Claude Code' : 'Codex'}? This grants access to the shared notes library.`)) continue;
    const current = await entry(agent, file);
    if (current && !matches(current, target) && !(replace && agents.includes(agent)) && !await ask(`A different garnet server exists in ${file}. Replace that entry?`)) continue;
    if (!selected) { await credential(target.runtime); await doctor(target, log); }
    selected++;
    if (!matches(current, target)) {
      await backup(file);
      // Each CLI owns its file format. Replacing an explicitly approved conflict
      // leaves all other server entries and unrelated configuration alone.
      if (current && agent === 'claude') run(command, ['mcp', 'remove', '--scope', 'user', 'garnet']);
      try {
        run(command, agent === 'claude' ? ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'garnet', '--', target.command, ...target.args] : ['mcp', 'add', 'garnet', '--', target.command, ...target.args]);
      } catch (error) { throw Error(`Could not configure ${agent}. A backup is beside ${file}. ${error.message}`); }
      if (!matches(await entry(agent, file), target)) throw Error(`${agent} did not save the expected Garnet configuration.`);
      tracking.entries = tracking.entries.filter(e => !(e.agent === agent && e.file === file));
      tracking.entries.push({ agent, file, executable: command, command: target.command, args: target.args, config: await entry(agent, file) });
      await atomicJSON(trackingFile, tracking);
    }
    log(`${agent}: Garnet configured. Start a new agent session to use it.`);
  }
  if (!selected) log('No agents connected. Rerun npx garnet-mcp setup whenever you are ready.');
}
export async function remove(target, { agents = ['claude', 'codex', 'manual'], log = console.log } = {}) {
  const trackingFile = path.join(target.runtime, 'mcp-install.json');
  const tracking = await optional(trackingFile, { entries: [] });
  const remaining = [];
  for (const saved of tracking.entries) {
    if (!agents.includes(saved.agent)) { remaining.push(saved); continue; }
    const current = await entry(saved.agent, saved.file);
    if (matches(current, saved) && isDeepStrictEqual(JSON.parse(JSON.stringify(current)), saved.config)) {
      await backup(saved.file);
      // Use the recorded config environment even if the caller's overrides changed.
      const variable = saved.agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
      const previous = process.env[variable];
      process.env[variable] = path.dirname(saved.file);
      if (saved.agent === 'claude' && saved.file === path.join(os.homedir(), '.claude.json')) delete process.env.CLAUDE_CONFIG_DIR;
      try { run(saved.executable, saved.agent === 'claude' ? ['mcp', 'remove', '--scope', 'user', 'garnet'] : ['mcp', 'remove', 'garnet']); }
      finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
      log(`${saved.agent}: Garnet removed.`);
    } else log(`${saved.agent}: configuration was changed elsewhere; preserved.`);
  }
  const manual = Boolean(tracking.manual && !agents.includes('manual'));
  await atomicJSON(trackingFile, { entries: remaining, manual });
  if (!remaining.length && !manual) await rm(path.join(target.runtime, 'mcp-token'), { force: true });
}
