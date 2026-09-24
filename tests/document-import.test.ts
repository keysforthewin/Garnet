import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeDocumentText, documentFormat, importText, maxImportBytes, maxImportCharacters } from '../shared/document-import.js';
import { extractDocument } from '../server/document-extraction.js';
import { docx, odt, pdf } from './fixtures/document-files.js';

test('text import preserves literal markup, whitespace, Unicode, and line breaks', () => {
  assert.equal(importText('\uFEFF# title\r\n\r\n<b>plain</b>\r café  '), '# title\n\n<b>plain</b>\n café  ');
  assert.equal(decodeDocumentText(new Uint8Array([0xff, 0xfe, 0x48, 0, 0x69, 0]).buffer), 'Hi');
  assert.equal(decodeDocumentText(new TextEncoder().encode('café').buffer), 'café');
  assert.throws(() => decodeDocumentText(new Uint8Array([0xff]).buffer), /UTF-8/);
  assert.throws(() => importText('\x00binary'), /binary/);
  assert.throws(() => importText(' \n'), /No readable text/);
  assert.throws(() => importText('a'.repeat(maxImportCharacters + 1)), /limit/);
});

test('recognizes document extensions without treating binary formats as plain text', () => {
  assert.equal(documentFormat('NOTES.MD'), 'text');
  assert.equal(documentFormat('unknown', 'text/plain'), 'text');
  assert.equal(documentFormat('page.htm'), 'html');
  assert.equal(documentFormat('page.rtf', 'text/rtf'), 'rtf');
  assert.equal(documentFormat('notes.doc'), 'doc');
  assert.equal(documentFormat('image.png', 'image/png'), null);
});

test('extracts real PDF, DOCX, ODT, RTF, and HTML document bytes', async () => {
  for (const [name, data, expected] of [
    ['sample.pdf', pdf(), 'PDF document text'],
    ['sample.docx', docx(), 'Word document text'],
    ['sample.odt', odt(), 'OpenDocument text'],
    ['sample.rtf', Buffer.from('{\\rtf1\\ansi RTF document text\\par Second line}'), 'RTF document text'],
    ['sample.html', Buffer.from('<html><body><h1>HTML document text</h1><script>alert(1)</script><p>Second line</p></body></html>'), 'HTML document text'],
  ] as const) {
    const text = await extractDocument(data, name);
    assert.ok(text.includes(expected), `${name}: ${text}`);
    assert.ok(!text.includes('<h1>') && !text.includes('alert(1)'), name);
  }
});

test('rejects malformed, empty, unsupported, and oversized documents', async () => {
  await assert.rejects(extractDocument(Buffer.from('not a pdf'), 'bad.pdf'));
  await assert.rejects(extractDocument(Buffer.from('not a doc'), 'bad.doc'));
  await assert.rejects(extractDocument(Buffer.from('not a zip'), 'bad.docx'));
  await assert.rejects(extractDocument(pdf(''), 'empty.pdf'), /No readable text/);
  await assert.rejects(extractDocument(Buffer.from('unsupported'), 'image.png'), /Unsupported/);
  await assert.rejects(extractDocument(new Uint8Array(maxImportBytes + 1), 'big.pdf'), /20 MB/);
});

test('extracts a legacy binary Word document, including Unicode text', async () => {
  const text = await extractDocument(await readFile(new URL('./fixtures/legacy-word.doc', import.meta.url)), 'legacy.doc');
  assert.ok(text.includes('This is a test for parsing the Word file in node.'));
  assert.ok(text.includes('这是一个'));
});
