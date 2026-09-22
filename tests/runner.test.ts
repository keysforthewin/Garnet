import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentRunner, type AgentJob } from '../runner/index';
import { defaults } from '../shared/types';

async function fixture() {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'garnet-agent-'));
  const executable = path.join(runtime, 'agent');
  await writeFile(executable, `#!${process.execPath}
let prompt = ''; process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'thread.started', thread_id:'session-123'}));
  if (prompt.includes('WAIT')) { setInterval(() => {}, 1000); return; }
  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:prompt.includes('MODEL') ? process.argv[process.argv.indexOf('--model')+1] : 'Integrated reply'}}));
});
`, { mode: 0o700 });
  const events: any[] = [];
  const runner = createAgentRunner(runtime, async (secret, event) => {
    assert.equal(secret, 'test-token');
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push(event);
  });
  const job = (id: string, prompt = 'Hello'): AgentJob => ({ id, provider: 'codex', prompt, secret: 'test-token', settings: { ...defaults.agent, codexPath: executable, claudePath: executable } });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Agent did not finish in time');
  };
  return { runtime, runner, events, job, wait, async cleanup() { await runner.shutdown(); await rm(runtime, { recursive: true, force: true }); } };
}
test('integrated agents stream ordered events and preserve sessions', async () => {
  const f = await fixture();
  try {
    await f.runner.start(f.job('complete'));
    await f.wait(() => f.runner.health().running === 0);
    assert.deepEqual(f.events.map(e => e.type), ['status', 'session', 'text', 'done']);
    assert.equal(f.events[1].sessionId, 'session-123');
    assert.equal(f.events[2].text, 'Integrated reply');
    assert.equal(f.events[3].status, 'completed');
  } finally { await f.cleanup(); }
});
test('missing executable fails the job and removes temporary CLI configuration', async () => {
  const f = await fixture();
  try {
    const job = f.job('missing'); job.provider = 'claude'; job.settings.claudePath = path.join(f.runtime, 'missing');
    await f.runner.start(job); await f.wait(() => f.runner.health().running === 0);
    assert.equal(f.events.at(-1).status, 'failed');
    assert.match(f.events.at(-1).error, /ENOENT/);
    assert.ok(!(await readdir(f.runtime)).some(name => name.endsWith('.mcp.json')));
  } finally { await f.cleanup(); }
});
test('cancellation and server shutdown stop jobs and await their final events', async () => {
  const f = await fixture();
  try {
    await f.runner.start(f.job('cancel', 'WAIT'));
    await f.wait(() => f.events.some(e => e.type === 'session'));
    f.runner.cancel('cancel'); await f.wait(() => f.runner.health().running === 0);
    assert.equal(f.events.at(-1).status, 'cancelled');
    await f.runner.start(f.job('shutdown', 'WAIT'));
    await f.runner.shutdown();
    assert.equal(f.events.at(-1).status, 'cancelled');
    assert.equal(f.runner.health().running, 0);
    await assert.rejects(f.runner.start(f.job('late')), /shutting down/);
  } finally { await f.cleanup(); }
});
test('job timeout reports failure', async () => {
  const f = await fixture();
  try {
    const job = f.job('timeout', 'WAIT'); job.settings.timeoutMinutes = 0.002;
    await f.runner.start(job); await f.wait(() => f.runner.health().running === 0);
    assert.equal(f.events.at(-1).status, 'failed'); assert.equal(f.events.at(-1).error, 'Agent timed out.');
  } finally { await f.cleanup(); }
});

test('each provider receives its own model override', async () => {
  const f = await fixture();
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const job = f.job(provider, 'MODEL'); job.provider = provider;
      job.settings.claudeModel = 'claude-chosen'; job.settings.codexModel = 'codex-chosen';
      await f.runner.start(job); await f.wait(() => f.runner.health().running === 0);
      assert.equal(f.events.filter(e => e.type === 'text').at(-1).text, `${provider}-chosen`);
    }
  } finally { await f.cleanup(); }
});
