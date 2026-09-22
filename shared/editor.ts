import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { getSchema } from '@tiptap/core';

export const extensions = () => [StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }), TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } }), Markdown];
export const schema = getSchema(extensions());
export const markdown = new MarkdownManager({ extensions: extensions() });
export function parseMarkdown(text: string) { return markdown.parse(text); }
export function serializeMarkdown(json: any) { return markdown.serialize(json); }

export function filename(title: string, id: string) {
  const stem = title.normalize('NFKC').replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim().replace(/\s+/g, '-').slice(0, 70) || 'Untitled';
  return `${stem}--${id}.md`;
}
