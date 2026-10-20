import type { Editor } from '@tiptap/core';
import { imageTypes, maxImageBytes } from '../shared/images';
import { csrf, toast } from './api';
import { anchor, commit } from './document-drop';

export const isImage = (file: File) => imageTypes.includes(file.type);

async function upload(file: File) {
  if (file.size > maxImageBytes) throw new Error('Images must be 10 MB or smaller.');
  const response = await fetch('/api/images', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': file.type, 'X-CSRF-Token': csrf }, body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not upload this image.');
  return result.src as string;
}

// Upload images in order and insert them together at `pos`, which follows later edits.
export function insertImages(target: Editor, files: File[], pos: number) {
  const find = anchor(target, pos);
  if (!find) { toast('Images can be added once the document has loaded.'); return; }
  const selection = target.state.selection;
  toast(`Uploading ${files.length === 1 ? 'image' : `${files.length} images`}…`);
  void (async () => {
    const sources: string[] = []; const errors: string[] = [];
    for (const file of files) {
      try { sources.push(await upload(file)); }
      catch (error) { errors.push(`${file.name || 'Image'}: ${error instanceof Error ? error.message : 'Could not upload image.'}`); }
    }
    if (target.isDestroyed) { toast('Image canceled because the document was closed.'); return; }
    if (sources.length) {
      const at = find();
      if (at === undefined || !target.isEditable) { toast('Image canceled because its position is no longer available.'); return; }
      const { schema } = target.state;
      commit(target, target.state.tr.replaceWith(at, at, sources.map(src => schema.nodes.image.create({ src, alt: '' }))), at, selection);
    }
    toast([sources.length ? `Inserted ${sources.length === 1 ? 'image' : `${sources.length} images`}.` : '', ...errors].filter(Boolean).join('\n'));
  })().catch(error => toast(`Could not insert image: ${error.message}`));
}

// Office apps put a picture of copied text on the clipboard beside the text, so
// paste images only when there is no text to paste.
export function pasteImages(target: Editor, event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || []).filter(isImage);
  if (!files.length || event.clipboardData!.getData('text/plain').trim()) return false;
  event.preventDefault();
  if (!target.isEditable) return true;
  if (!target.state.selection.empty) target.view.dispatch(target.state.tr.deleteSelection());
  insertImages(target, files, target.state.selection.from);
  return true;
}
