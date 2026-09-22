import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import type { ModelCatalog, AgentProvider } from '../shared/types';

// Discovery performs only the CLI initialization/model-list handshake: no prompt
// or model generation. These subprocesses exit as soon as their catalog arrives.
export function discoverModels(provider: AgentProvider, executable: string, cwd = os.homedir(), signal?: AbortSignal, timeoutMs = 15000): Promise<ModelCatalog> {
  return new Promise(resolve => {
    let settled = false; let exited = false; let outputSize = 0; let requestId = 1;
    const models: ModelCatalog['models'] = [];
    const args = provider === 'codex' ? ['app-server'] : ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}'];
    const child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const kill = (sig: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, sig); } catch {} } };
    const finish = (error?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const result = { models: error ? [] : [...new Map(models.map(model => [model.id, model])).values()], ...(error ? { error } : {}) };
      if (exited) { resolve(result); return; }
      child.stdin.end(); kill('SIGTERM');
      const force = setTimeout(() => kill('SIGKILL'), 1000);
      child.once('close', () => { clearTimeout(force); resolve(result); });
    };
    const abort = () => finish('Model discovery cancelled.');
    const timer = setTimeout(() => finish('Model discovery timed out. Try refreshing or enter a custom model.'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const send = (value: unknown) => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n'); };
    child.stdin.on('error', () => finish('The executable closed before returning its model list.'));
    child.stderr.resume();
    child.stdout.on('data', chunk => { outputSize += chunk.length; if (outputSize > 2_000_000) finish('The executable returned an unexpectedly large response.'); });
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' ? 'Executable not found. Check its path.' : 'Unable to start the executable. Check its path and working directory.'));
    child.on('close', () => { exited = true; finish('No model list was returned. Update the CLI or enter a custom model.'); });
    createInterface({ input: child.stdout }).on('line', line => {
      if (settled) return;
      let message: any; try { message = JSON.parse(line); } catch { return; }
      if (provider === 'claude') {
        if (message.type !== 'control_response' || message.response?.request_id !== 'models') return;
        const list = message.response?.response?.models;
        if (!Array.isArray(list)) return finish('This Claude executable did not return a model list.');
        for (const model of list) if (typeof model.value === 'string' && model.value) models.push({ id: model.value, name: model.displayName || model.value, description: model.description || '' });
        finish();
      } else {
        if (message.id !== requestId) return;
        if (message.error) return finish('Codex model discovery failed. Check the CLI login or enter a custom model.');
        if (requestId === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: ++requestId, method: 'model/list', params: { limit: 100 } });
        } else {
          if (!Array.isArray(message.result?.data)) return finish('This Codex executable did not return a model list.');
          for (const model of message.result.data) if (typeof model.model === 'string' && model.model && !model.hidden) models.push({ id: model.model, name: model.displayName || model.model, description: model.description || '' });
          if (message.result.nextCursor && requestId < 20) send({ id: ++requestId, method: 'model/list', params: { limit: 100, cursor: message.result.nextCursor } });
          else finish();
        }
      }
    });
    if (signal?.aborted) { abort(); return; }
    send(provider === 'claude' ? { type: 'control_request', request_id: 'models', request: { subtype: 'initialize', hooks: {} } } : { id: requestId, method: 'initialize', params: { clientInfo: { name: 'garnet', version: '0.1.0' } } });
  });
}

export function createModelCatalog() {
  const entries = new Map<AgentProvider, { key: string; at: number; controller: AbortController; value: Promise<ModelCatalog> }>();
  return {
    get(provider: AgentProvider, executable: string, cwd: string, refresh = false) {
      const key = JSON.stringify([executable, cwd]); const existing = entries.get(provider);
      if (!refresh && existing?.key === key && Date.now() - existing.at < 300000) return existing.value;
      existing?.controller.abort();
      const controller = new AbortController();
      const value = discoverModels(provider, executable, cwd || os.homedir(), controller.signal);
      entries.set(provider, { key, at: Date.now(), controller, value }); return value;
    },
    async close() { const pending = [...entries.values()]; for (const entry of pending) entry.controller.abort(); entries.clear(); await Promise.all(pending.map(entry => entry.value)); },
  };
}
