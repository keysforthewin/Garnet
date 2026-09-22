import { spawn, type ChildProcess } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../shared/types.js';

export interface AgentJob {
  id: string; provider: 'claude' | 'codex'; prompt: string; docId?: string | null;
  sessionId?: string; secret: string; settings: Settings['agent'];
}
export function createAgentRunner(runtime: string, post: (secret: string, event: any) => Promise<void>) {
  const appSocket = path.join(runtime, 'app.sock');
  const children = new Map<string, { child: ChildProcess; cancel: () => void; finished: Promise<void> }>();
  let stopping = false;
  async function start(job: AgentJob) {
    if (stopping) throw new Error('Server is shutting down.');
    if (children.has(job.id)) throw new Error('Job already running.');
    const config = job.settings;
    const model = job.provider === 'claude' ? config.claudeModel : config.codexModel;
    const toolPath = fileURLToPath(new URL('./tools.mjs', import.meta.url));
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
      if (model) args.push('--model', model);
    } else {
      command = config.codexPath;
      args = ['exec', ...(job.sessionId ? ['resume', job.sessionId] : []), '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', `mcp_servers.garnet.command=${JSON.stringify(mcp.command)}`, '-c', `mcp_servers.garnet.args=${JSON.stringify(mcp.args)}`, '-c', 'mcp_servers.garnet.env_vars=["ED_JOB_TOKEN"]'];
      if (model) args.push('--model', model);
      args.push('-');
    }
    if (stopping) { if (configFile) await unlink(configFile).catch(() => {}); throw new Error('Server is shutting down.'); }
    let resolveFinished!: () => void;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
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
    children.set(job.id, { child, finished, cancel: () => { cancelled = true; stop(); } });
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
      if (done) return; done = true; clearTimeout(timeout); clearInterval(heartbeat);
      const status = cancelled ? 'cancelled' : timedOut || error || outputError || code !== 0 ? 'failed' : 'completed';
      emit({ type: 'done', status, error: status === 'failed' ? (error?.message || (timedOut ? 'Agent timed out.' : outputError || stderr || `Agent exited with code ${code}`)) : null });
      await queue; if (configFile) await unlink(configFile).catch(() => {});
      children.delete(job.id); resolveFinished();
    }
    child.on('error', error => void finish(null, error)); child.on('close', code => void finish(code));
  }
  return {
    start,
    cancel(id: string) { children.get(id)?.cancel(); },
    health() { return { ok: !stopping, running: children.size, user: os.userInfo().username }; },
    async shutdown() {
      stopping = true;
      const running = [...children.values()];
      for (const job of running) job.cancel();
      await Promise.all(running.map(job => job.finished));
    },
  };
}
