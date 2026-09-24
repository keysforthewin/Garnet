export const maxImportBytes = 20 * 1024 * 1024;
export const maxImportCharacters = 2 * 1024 * 1024;

const textExtensions = new Set(['txt', 'text', 'md', 'markdown', 'mdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log']);
const convertedExtensions = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'html', 'htm', 'epub', 'pptx', 'xlsx', 'odp', 'ods', 'odg']);
export function documentFormat(name: string, mime = '') {
  const extension = name.split('.').pop()!.toLowerCase();
  if (convertedExtensions.has(extension)) return extension === 'htm' ? 'html' : extension;
  if (mime.split(';')[0] === 'text/html') return 'html';
  if (mime.split(';')[0] === 'text/rtf') return 'rtf';
  if (textExtensions.has(extension) || mime.startsWith('text/')) return 'text';
  return null;
}

export function importText(text: string) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (normalized.length > maxImportCharacters) throw new Error('Extracted text exceeds the 2 MB character limit.');
  if (/\x00/.test(normalized)) throw new Error('This file contains binary data, not readable text.');
  if (!normalized.trim()) throw new Error('No readable text found. Scanned documents need OCR before importing.');
  return normalized;
}

export function decodeDocumentText(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new Error('Save this text file as UTF-8 or UTF-16 and try again.'); }
}
