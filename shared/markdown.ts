import { getSchema } from '@tiptap/core';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { extensions } from './editor';

export const schema = getSchema(extensions());
export const markdown = new MarkdownManager({ extensions: [...extensions(), Markdown] });
export function parseMarkdown(text: string) { return markdown.parse(text); }
export function serializeMarkdown(json: any) { return markdown.serialize(json); }
