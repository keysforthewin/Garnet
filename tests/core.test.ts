import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { updateYFragment, initProseMirrorDoc, yDocToProsemirrorJSON, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap';
import { filename } from '../shared/editor';
import { parseMarkdown, serializeMarkdown, schema } from '../shared/markdown';
import { hashPassword, verifyPassword, validatePassword, cookieValue } from '../server/auth';
import { persistenceSignature, documentSignature } from '../shared/sync';
function set(doc: Y.Doc, markdown: string) { const fragment = doc.getXmlFragment('default'); const { mapping } = initProseMirrorDoc(fragment, schema); updateYFragment(doc, fragment, schema.nodeFromJSON(parseMarkdown(markdown)), { mapping, isOMark: new Map() }); }
test('Markdown keeps headings, tasks, links, code, and tables through repeated conversions', () => {
  const text = '# Notes\n\n- [ ] First task\n- [x] Done\n\n[Link](https://example.com) and **bold**.\n\n```js\nconst value = 1\n```\n\n| A | B |\n| --- | --- |\n| one | two |';
  const once = serializeMarkdown(parseMarkdown(text));
  assert.deepEqual(parseMarkdown(once), parseMarkdown(serializeMarkdown(parseMarkdown(once))));
  for (const match of ['# Notes', '[ ] First task', '[x] Done', 'https://example.com', 'const value = 1', 'one']) assert.ok(once.includes(match), match);
});
test('concurrent offline changes merge without losing either writer', () => {
  const a = new Y.Doc(); set(a, 'Original'); const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const textA = (a.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const textB = (b.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
  textA.insert(0, 'Alice '); textB.insert(8, ' Bob');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.deepEqual(yDocToProsemirrorJSON(a, 'default'), yDocToProsemirrorJSON(b, 'default'));
  const result = serializeMarkdown(yDocToProsemirrorJSON(a, 'default')); assert.match(result, /Alice/); assert.match(result, /Bob/);
});
test('targeted document changes preserve anchored cursor positions', () => {
  const doc = new Y.Doc(); set(doc, 'Hello world');
  const fragment = doc.getXmlFragment('default'); const first = initProseMirrorDoc(fragment, schema);
  const cursor = absolutePositionToRelativePosition(7, fragment, first.mapping);
  set(doc, 'Say Hello world'); const second = initProseMirrorDoc(fragment, schema);
  assert.equal(relativePositionToAbsolutePosition(doc, fragment, cursor, second.mapping), 11);
});
test('password verification and bootstrap replacement rules', async () => {
  const stored = await hashPassword('a good long password'); assert.equal(await verifyPassword('a good long password', stored), true); assert.equal(await verifyPassword('wrong', stored), false);
  assert.throws(() => validatePassword('password')); validatePassword('another strong password');
  assert.equal(cookieValue('other=a; ed_session=123; next=x', 'ed_session'), '123');
});
test('mirror filenames cannot escape the document directory', () => {
  const name = filename('../../etc/passwd / unsafe', 'abc-123'); assert.equal(name.includes('/'), false); assert.equal(name.includes('..'), false); assert.match(name, /--abc-123\.md$/);
});
test('persistence acknowledgment detects deletion even when version clocks are unchanged', () => {
  const doc = new Y.Doc(); set(doc, 'Original text'); const before = Y.encodeStateAsUpdate(doc); const vector = Y.encodeStateVector(doc);
  const text = (doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText; text.delete(0, 4);
  assert.deepEqual(Y.encodeStateVector(doc), vector);
  assert.notEqual(persistenceSignature(before), persistenceSignature(Y.encodeStateAsUpdate(doc)));
});
test('a live document signs the same as its encoded state, including other writers and deletions', () => {
  const a = new Y.Doc(); set(a, 'First paragraph\n\nSecond paragraph\n\nThird'); const b = new Y.Doc(); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const text = (doc: Y.Doc, index: number) => (doc.getXmlFragment('default').get(index) as Y.XmlElement).get(0) as Y.XmlText;
  text(a, 0).insert(5, ' edited'); text(b, 1).delete(0, 7); text(b, 2).insert(0, 'Very '); text(a, 2).delete(2, 2);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); a.getXmlFragment('default').delete(1, 1);
  assert.equal(documentSignature(a), persistenceSignature(Y.encodeStateAsUpdate(a)));
  // Updates that cannot be integrated yet are part of the encoded state, so they must count too.
  const c = new Y.Doc(); const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(a));
  text(d, 0).insert(0, 'x'); const afterX = Y.encodeStateVector(d); text(d, 0).insert(0, 'y');
  Y.applyUpdate(c, Y.encodeStateAsUpdate(a)); Y.applyUpdate(c, Y.encodeStateAsUpdate(d, afterX)); assert.ok(c.store.pendingStructs);
  assert.equal(documentSignature(c), persistenceSignature(Y.encodeStateAsUpdate(c)));
});
