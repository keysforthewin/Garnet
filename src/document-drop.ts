import type { Editor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import { documentFormat, decodeDocumentText, importText, maxImportBytes, maxImportCharacters } from '../shared/document-import';
import { csrf, toast } from './api';

async function extract(file: File) {
  if (file.size > maxImportBytes) throw new Error('Files must be 20 MB or smaller.');
  const format = documentFormat(file.name, file.type);
  if (!format) throw new Error('Unsupported document format.');
  if (format === 'text') return importText(decodeDocumentText(await file.arrayBuffer()));
  const response = await fetch(`/api/document-text?name=${encodeURIComponent(`document.${format}`)}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not extract this document.');
  return importText(result.text);
}

// Capture a Yjs position before any asynchronous reads, so local and remote edits
// cannot move an import away from the place the user dropped it.
export function dropDocuments(target: Editor, event: DragEvent, fallbackPosition?: number) {
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return false;
  event.preventDefault();
  if (!target.isEditable) return true;
  const pos = fallbackPosition ?? target.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  const sync = ySyncPluginKey.getState(target.state);
  if (pos === undefined || !sync?.binding) { toast('Drop the file over the document text.'); return true; }
  const anchor = absolutePositionToRelativePosition(pos, sync.type, sync.binding.mapping);
  const selection = target.state.selection;
  toast(`Reading ${files.length === 1 ? files[0].name : `${files.length} documents`}…`);
  void (async () => {
    const texts: string[] = []; const errors: string[] = [];
    let length = 0;
    // Preserve file order, including when some files fail to convert.
    for (const file of files) {
      try {
        const text = await extract(file);
        if (length + text.length > maxImportCharacters) throw new Error('Combined text exceeds the 2 MB character limit. Drop fewer files at a time.');
        texts.push(text); length += text.length + 2;
      } catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : 'Could not read file.'}`); }
    }
    if (target.isDestroyed) { toast('Import canceled because the destination document was closed.'); return; }
    if (texts.length) {
      const current = ySyncPluginKey.getState(target.state);
      const at = current?.binding && relativePositionToAbsolutePosition(current.doc, current.type, anchor, current.binding.mapping);
      if (at == null || !target.isEditable) { toast('Import canceled because the drop position is no longer available.'); return; }
      const text = texts.join('\n\n'); const { schema } = target.state;
      const transaction = target.state.tr;
      if (transaction.doc.resolve(at).parent.type.spec.code) transaction.insertText(text, at, at);
      else {
        const paragraphs = text.split('\n').map(line => schema.nodes.paragraph.create(null, line ? schema.text(line) : undefined));
        transaction.replaceRange(at, at, new Slice(Fragment.fromArray(paragraphs), 1, 1));
      }
      // Do not steal focus from another document or interrupt typing during conversion.
      const moveCaret = target.view.dom.isConnected && target.state.selection.eq(selection);
      if (moveCaret) transaction.setSelection(TextSelection.near(transaction.doc.resolve(transaction.mapping.map(at, 1))));
      const undo = yUndoPluginKey.getState(target.state)?.undoManager;
      undo?.stopCapturing();
      target.view.dispatch(transaction);
      undo?.stopCapturing();
      if (moveCaret) target.view.focus();
    }
    toast([texts.length ? `Inserted ${texts.length === 1 ? 'document text' : `${texts.length} documents`}.` : '', ...errors].filter(Boolean).join('\n'));
  })().catch(error => toast(`Could not insert document: ${error.message}`));
  return true;
}
