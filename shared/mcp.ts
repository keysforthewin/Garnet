import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9-]{1,80}$/).describe('Document ID returned by the library');
const markdown = z.string().refine(value => new TextEncoder().encode(value).length <= 2 * 1024 * 1024, 'Markdown must be smaller than 2 MB');
export const documentTools = {
  list_documents: { description: 'List documents in the Garnet shared notes library.', schema: z.object({}).strict() },
  search_documents: { description: 'Search Garnet document titles and contents.', schema: z.object({ query: z.string().max(1000) }).strict() },
  read_document: { description: 'Read live Garnet Markdown and its version before editing.', schema: z.object({ id }).strict() },
  create_document: { description: 'Create a Garnet note. Use Markdown task lists (- [ ] task) for to-do lists.', schema: z.object({ title: z.string().max(200), markdown: markdown.optional() }).strict() },
  edit_document: { description: 'Edit a Garnet note using its last read version. Supply find/replace for a small change or markdown for full content. On conflict, read and retry.', schema: z.object({ id, version: z.string().min(1), markdown: markdown.optional(), find: z.string().min(1).optional(), replace: markdown.optional() }).strict().refine(v => v.markdown !== undefined ? v.find === undefined && v.replace === undefined : v.find !== undefined && v.replace !== undefined, 'Supply either markdown or both find and replace') },
};
export type DocumentToolName = keyof typeof documentTools;
export const libraryInstructions = 'Use these tools to list, search, read, create and edit the Garnet shared notes library. Read before editing and supply its version. Prefer find/replace for small edits; reread and retry conflicts without discarding human work. Markdown mirror files are exports, not editable source documents. Use - [ ] and - [x] for task lists.';
