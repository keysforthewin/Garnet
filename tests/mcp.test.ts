import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { documentTools } from '../shared/mcp';
import { validLocalCredential } from '../server/mcp-access';
import { canAnimate, typingDuration } from '../shared/agent-edits';

test('edit contract rejects mixed modes, missing replacements, and excessive content before mutation', () => {
  const edit = documentTools.edit_document.schema;
  for (const args of [{}, { id: 'abc', version: 'v' }, { id: 'abc', version: 'v', find: 'a' }, { id: 'abc', version: 'v', markdown: 'a', find: 'x', replace: 'b' }, { id: 'abc', version: '', markdown: 'a' }]) assert.equal(edit.safeParse(args).success, false);
  assert.equal(edit.safeParse({ id: 'abc', version: 'v', find: 'a', replace: '' }).success, true);
  assert.equal(documentTools.create_document.schema.safeParse({ title: 'Test', markdown: '😀'.repeat(524289) }).success, false);
});
test('animation budget includes existing work, handles exact boundary and long content', () => {
  assert.equal(typingDuration(240), 1000);
  assert.equal(canAnimate(0, 480), true);
  assert.equal(canAnimate(0, 481), false);
  assert.equal(canAnimate(1000, 240), true);
  assert.equal(canAnimate(1001, 240), false);
});
test('local credentials require the owner-only file and revoke immediately', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'garnet-mcp-access-')); const file = path.join(dir, 'token'); const secret = 'a'.repeat(64);
  try {
    assert.equal(await validLocalCredential(file, secret), false);
    await writeFile(file, secret, { mode: 0o600 });
    assert.equal(await validLocalCredential(file, secret), true);
    assert.equal(await validLocalCredential(file, 'b'.repeat(64)), false);
    await chmod(file, 0o644); assert.equal(await validLocalCredential(file, secret), false);
    await rm(file); assert.equal(await validLocalCredential(file, secret), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SDK adapter initializes, lists tools, forwards authentication, and reports backend failures', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'garnet-mcp-wire-')); const socket = path.join(dir, 'app.sock'); const secret = 'b'.repeat(64); const credential = path.join(dir, 'token');
  await writeFile(credential, secret);
  let calls = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls++;
    res.setHeader('content-type', 'application/json');
    if (body.name === 'edit_document') { res.statusCode = 409; res.end(JSON.stringify({ error: 'Document changed. Read and retry.' })); }
    else res.end(JSON.stringify([{ id: 'abc', title: 'Library' }]));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', path.resolve('runner/tools.ts'), '--socket', socket, '--credential-file', credential] }));
    assert.equal((await client.listTools()).tools.length, 5);
    assert.ok((await client.callTool({ name: 'list_documents', arguments: {} })).content);
    const conflict = await client.callTool({ name: 'edit_document', arguments: { id: 'abc', version: 'v', markdown: 'new' } });
    assert.equal(conflict.isError, true);
    const invalid = await client.callTool({ name: 'edit_document', arguments: { id: 'abc', version: 'v' } });
    assert.equal(invalid.isError, true); assert.equal(calls, 2);
    await rm(credential);
    assert.equal((await client.callTool({ name: 'list_documents', arguments: {} })).isError, true);
  } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('agent edit events detect deletion-only changes even when Yjs clocks do not advance', async () => {
  const Y = await import('yjs');
  const { initProseMirrorDoc, updateYFragment } = await import('@tiptap/y-tiptap');
  const { schema, parseMarkdown } = await import('../shared/markdown');
  const { documentSignature } = await import('../shared/sync');
  const { agentEditEvent } = await import('../server/agent-edits');
  const doc = new Y.Doc(); const fragment = doc.getXmlFragment('default');
  const update = (text: string) => updateYFragment(doc, fragment, schema.nodeFromJSON(parseMarkdown(text)), { mapping: initProseMirrorDoc(fragment, schema).mapping, isOMark: new Map() });
  update('Keep this and remove this.');
  const before = initProseMirrorDoc(fragment, schema).doc;
  const oldSignature = documentSignature(doc);
  update('Keep this');
  const event = agentEditEvent(doc, before, 'v');
  assert.ok(event); assert.equal(event.signature, documentSignature(doc)); assert.notEqual(event.signature, oldSignature); assert.equal(event.textChanged, true);
  const plain = initProseMirrorDoc(fragment, schema).doc;
  update('**Keep this**');
  assert.equal(agentEditEvent(doc, plain, 'v2')?.textChanged, false);
  doc.destroy();
});
