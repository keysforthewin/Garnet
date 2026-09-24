import { documentFormat, importText, maxImportBytes } from '../shared/document-import.js';

export async function extractDocument(data: Uint8Array, name: string): Promise<string> {
  if (data.byteLength > maxImportBytes) throw new Error('Files must be 20 MB or smaller.');
  const format = documentFormat(name);
  if (!format || format === 'text') throw new Error('Unsupported document format.');
  const buffer = Buffer.from(data);
  let text: string;
  if (format === 'doc') {
    const { default: WordExtractor } = await import('word-extractor');
    const document = await new WordExtractor().extract(buffer);
    text = [document.getBody(), document.getFootnotes(), document.getEndnotes(), document.getTextboxes()].filter(Boolean).join('\n\n');
  } else {
    const { parseOffice } = await import('officeparser');
    const document = await parseOffice(buffer, {
      fileType: format as import('officeparser').SupportedFileType,
      extractAttachments: false, ocr: false, ignoreComments: true,
    });
    text = (await document.to('text')).value;
  }
  return importText(text);
}
