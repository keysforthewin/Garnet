import * as Y from 'yjs';
import { absolutePositionToRelativePosition, initProseMirrorDoc } from '@tiptap/y-tiptap';
import type { Node } from '@tiptap/pm/model';
import { schema } from '../shared/markdown.js';
import type { AgentEditEvent } from '../shared/agent-edits.js';
import { documentSignature } from '../shared/sync.js';
import { randomUUID } from 'node:crypto';

export function agentEditEvent(doc: Y.Doc, before: Node, version: string): AgentEditEvent | undefined {
  const fragment = doc.getXmlFragment('default');
  const { doc: after, mapping } = initProseMirrorDoc(fragment, schema);
  const start = before.content.findDiffStart(after.content);
  if (start === null) return;
  const end = before.content.findDiffEnd(after.content);
  const from = Math.min(start, after.content.size);
  const to = Math.max(from, end?.b ?? from);
  return { textChanged: before.textContent !== after.textContent, type: 'agent-edit', id: randomUUID(), version, signature: documentSignature(doc),
    from: Y.relativePositionToJSON(absolutePositionToRelativePosition(from, fragment, mapping)),
    to: Y.relativePositionToJSON(absolutePositionToRelativePosition(to, fragment, mapping)) };
}
