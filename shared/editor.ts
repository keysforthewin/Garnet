import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';

// Markdown conversion lives in ./markdown so the browser can load it, and its
// parser, after the editor is already on screen.
export const extensions = () => [StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }), TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } })];

export function filename(title: string, id: string) {
  const stem = title.normalize('NFKC').replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim().replace(/\s+/g, '-').slice(0, 70) || 'Untitled';
  return `${stem}--${id}.md`;
}
