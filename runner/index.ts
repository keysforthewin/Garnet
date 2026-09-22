import { createServer, request } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, unlink, chmod, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const runtime = path.resolve(arg('runtime', './data/runtime'));
const appSocket = path.join(runtime, 'app.sock');
const ownSocket = path.join(runtime, 'runner.sock');
const children = new Map<string, { child: ChildProcess; cancel: () => void }>();
await mkdir(runtime, { recursive: true });
await unlink(ownSocket).catch(() => {});
function post(secret: string, body: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: appSocket, path: '/event', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, timeout: 5000 }, res => {
      res.resume(); res.on('end', () => res.statusCode! < 300 ? resolve() : reject(new Error(`Event rejected: ${res.statusCode}`)));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('App unavailable'))); req.end(JSON.stringify(body));
  });
}
async function start(job: any) {
  const config = job.settings;
  const toolPath = new URL('./tools.mjs', import.meta.url).pathname;
  const mcp = { command: process.execPath, args: [toolPath, '--socket', appSocket] };
  const instructions = `You are helping with a shared notes library. Use the Garnet library MCP tools to list, search, read, create, and edit documents. Read before editing and supply the returned version. Prefer find/replace for small changes. If a conflict occurs, reread and retry without discarding other people's work. Markdown files on disk are export mirrors: edits to them do not enter the library. Apply all requested library edits through the tools. Current document ID: ${job.docId || 'none; use the library tools to select documents'}. You also have the host account's full CLI access for other requested tasks.`;
  const prompt = `${instructions}\n\nUser request:\n${job.prompt}`;
  let command: string; let args: string[]; let configFile: string | undefined;
  if (job.provider === 'claude') {
    command = config.claudePath;
    configFile = path.join(runtime, `${job.id}.mcp.json`);
    await writeFile(configFile, JSON.stringify({ mcpServers: { garnet: mcp } }), { mode: 0o600 });
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions', '--mcp-config', configFile];
    if (job.sessionId) args.push('--resume', job.sessionId);
    if (config.model) args.push('--model', config.model);
  } else {
    command = config.codexPath;
    args = ['exec', ...(job.sessionId ? ['resume', job.sessionId] : []), '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', `mcp_servers.garnet.command=${JSON.stringify(mcp.command)}`, '-c', `mcp_servers.garnet.args=${JSON.stringify(mcp.args)}`, '-c', 'mcp_servers.garnet.env_vars=["ED_JOB_TOKEN"]'];
    if (config.model) args.push('--model', config.model);
    args.push('-');
  }
  const child = spawn(command, args, { cwd: config.cwd || os.homedir(), env: { ...process.env, ED_JOB_TOKEN: job.secret }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let cancelled = false; let timedOut = false; let done = false; let queue = Promise.resolve();
  let partial = false; let stderr = ''; let outputError = '';
  const emit = (event: any) => {
    queue = queue.then(async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        try { await post(job.secret, event); return; } catch (error) { if (attempt === 5) throw error; await new Promise(r => setTimeout(r, Math.min(500 * 2 ** attempt, 5000))); }
      }
    }).catch(error => console.error(`Agent event ${job.id}: ${error.message}`));
  };
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 3000).unref(); } };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, config.timeoutMinutes * 60000);
  const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15000);
  children.set(job.id, { child, cancel: () => { cancelled = true; stop(); } });
  emit({ type: 'status', text: `Running ${job.provider}` });
  createInterface({ input: child.stdout! }).on('line', line => {
    if (line.length > 500000) { emit({ type: 'activity', text: 'Large tool output omitted.' }); return; }
    let event: any; try { event = JSON.parse(line); } catch { emit({ type: 'activity', text: line.slice(0, 4000) }); return; }
    if (event.type === 'thread.started') emit({ type: 'session', sessionId: event.thread_id });
    if (event.type === 'system' && event.session_id) emit({ type: 'session', sessionId: event.session_id });
    if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') { partial = true; emit({ type: 'text', text: event.event.delta.text }); }
    if (event.type === 'assistant') {
      for (const block of event.message?.content || []) {
        if (block.type === 'text' && !partial) emit({ type: 'text', text: block.text });
        if (block.type === 'tool_use') emit({ type: 'activity', text: block.name });
      }
      partial = false;
    }
    if (event.type === 'result' && event.is_error) outputError = String(event.result || event.errors?.join('\n') || 'Agent reported an error.');
    if (event.type === 'item.completed') {
      const item = event.item;
      if (item?.type === 'agent_message') emit({ type: 'text', text: item.text });
      else emit({ type: 'activity', text: item?.command || item?.tool || item?.type || 'Tool completed' });
    }
    if (event.type === 'error' || event.type === 'turn.failed') { outputError = String(event.message || event.error?.message || 'Agent failed.'); emit({ type: 'activity', text: outputError }); }
  });
  child.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
  child.stdin!.on('error', () => {}); child.stdin!.end(prompt);
  async function finish(code: number | null, error?: Error) {
    if (done) return; done = true; clearTimeout(timeout); clearInterval(heartbeat); children.delete(job.id);
    const status = cancelled ? 'cancelled' : timedOut || error || outputError || code !== 0 ? 'failed' : 'completed';
    emit({ type: 'done', status, error: status === 'failed' ? (error?.message || (timedOut ? 'Agent timed out.' : outputError || stderr || `Agent exited with code ${code}`)) : null });
    await queue; if (configFile) await unlink(configFile).catch(() => {});
  }
  child.on('error', error => void finish(null, error)); child.on('close', code => void finish(code));
}
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.url === '/health') { res.end(JSON.stringify({ ok: true, running: children.size, user: os.userInfo().username })); return; }
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 200000) throw new Error('Request too large'); }
    const body = JSON.parse(raw);
    if (req.url === '/run') { if (children.has(body.id)) throw new Error('Job already running'); await start(body); }
    else if (req.url === '/cancel') children.get(body.id)?.cancel();
    else throw new Error('Unknown runner command');
    res.end('{"ok":true}');
  } catch (error: any) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
});
server.listen(ownSocket, async () => { await chmod(ownSocket, 0o600); console.log(`Garnet host runner: ${ownSocket}`); });
function stopAll() { for (const running of children.values()) running.cancel(); server.close(); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', stopAll); process.on('SIGINT', stopAll);
