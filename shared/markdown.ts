import { getSchema } from '@tiptap/core';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { extensions } from './editor';

export const schema = getSchema(extensions());
export const markdown = new MarkdownManager({ extensions: [...extensions(), Markdown] });
// The Markdown parser lifts an image alone in its paragraph out to block level, but
// images are inline, so put each such image back in a paragraph.
function wrapImages(node: any): any {
  if (!node.content) return node;
  const block = !schema.nodes[node.type]?.isTextblock;
  return { ...node, content: node.content.map((child: any) => block && child.type === 'image' ? { type: 'paragraph', content: [child] } : wrapImages(child)) };
}
export function parseMarkdown(text: string) { return wrapImages(markdown.parse(text)); }
export function serializeMarkdown(json: any) { return markdown.serialize(json); }
