// Explicitly targets the disposable test app, never the production library.
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:8081/api';
const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'ed-test-password-2026' }) });
const auth = await login.json(); assert.ok(auth.csrf, 'Initialize the browser-test database first.');
const cookie = login.headers.get('set-cookie').split(';')[0];
async function api(route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${result.error}`); return result;
}
assert.equal((await api('/runner')).ok, true, 'Start the runner against data/test-runtime first.');
const marker = Date.now();
for (const provider of ['claude', 'codex']) {
  const title = `Agent smoke ${provider} ${marker}`;
  const job = await api('/jobs', 'POST', { provider, prompt: `Use only the Garnet library MCP document tools for this test. Create a document titled "${title}" containing exactly "Agent integration verified." Read the created document back to verify it. Do not run any shell commands or modify any other files. Reply briefly when done.` });
  let result;
  for (let i = 0; i < 90; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = (await api(`/conversations/${job.conversationId}/jobs`)).find(j => j._id === job.id);
    if (!['queued', 'running'].includes(result.status)) break;
  }
  console.log(provider, result.status, result.error || '');
  if (result.status !== 'completed') { console.log(JSON.stringify(result.events.slice(-8), null, 2)); process.exitCode = 1; continue; }
  const doc = (await api('/documents')).find(d => d.title === title); assert.ok(doc, 'Agent created its test document');
  assert.match((await api(`/documents/${doc.id}/state`)).markdown, /Agent integration verified/);
  const followup = await api('/jobs', 'POST', { conversationId: job.conversationId, prompt: `Use the Garnet library tools to read the document you just created, then append a new paragraph saying "Session continuation verified." Do not run shell commands or change other documents.` });
  for (let i = 0; i < 90; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    result = (await api(`/conversations/${job.conversationId}/jobs`)).find(j => j._id === followup.id);
    if (!['queued', 'running'].includes(result.status)) break;
  }
  console.log(provider, 'resume', result.status, result.error || '');
  assert.equal(result.status, 'completed'); assert.match((await api(`/documents/${doc.id}/state`)).markdown, /Session continuation verified/);
}
const cancelled = await api('/jobs', 'POST', { provider: 'claude', prompt: 'Say hello without using any tools.' });
await api(`/jobs/${cancelled.id}/cancel`, 'POST', {});
for (let i = 0; i < 30; i++) {
  const result = (await api(`/conversations/${cancelled.conversationId}/jobs`)).find(j => j._id === cancelled.id);
  if (!['queued', 'running'].includes(result.status)) { assert.equal(result.status, 'cancelled'); console.log('cancellation verified'); break; }
  if (i === 29) throw new Error('Cancellation did not complete');
  await new Promise(resolve => setTimeout(resolve, 1000));
}
