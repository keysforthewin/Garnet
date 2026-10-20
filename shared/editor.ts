import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { Image } from '@tiptap/extension-image';
import { Link } from './link';

// Only images uploaded to Garnet display under its content policy, so pasted web
// pages keep dropping their remote images.
const UploadedImage = Image.extend({ parseHTML: () => [{ tag: 'img[src^="/api/images/"]' }] });

// Markdown conversion lives in ./markdown so the browser can load it, and its
// parser, after the editor is already on screen.
export const extensions = () => [StarterKit.configure({ undoRedo: false, link: false }), Link.configure({ openOnClick: false }), UploadedImage.configure({ inline: true }), TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } })];

export function filename(title: string, id: string) {
  const stem = title.normalize('NFKC').replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim().replace(/\s+/g, '-').slice(0, 70) || 'Untitled';
  return `${stem}--${id}.md`;
}
