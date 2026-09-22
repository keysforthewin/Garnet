export interface Revision {
  _id: string;
  docId: string;
  markdown: string;
  previousMarkdown?: string;
  reason: string;
  createdAt: number;
}
export type SavedRevision = Revision & { previousMarkdown: string };

// Older entries stored the content before a save. Read them as completed saves,
// using the next snapshot (or current document) as their resulting content.
export function savedRevisions(entries: Revision[], currentMarkdown: string): SavedRevision[] {
  return entries.map((entry, index) => ({
    ...entry,
    reason: entry.reason.replace(/^before /, ''),
    previousMarkdown: entry.previousMarkdown ?? entry.markdown,
    markdown: entry.previousMarkdown !== undefined ? entry.markdown : entries[index + 1]?.previousMarkdown ?? entries[index + 1]?.markdown ?? currentMarkdown,
  })).filter(entry => entry.previousMarkdown !== entry.markdown).reverse();
}

export interface DiffPart { kind: 'same' | 'added' | 'removed'; lines: string[] }
export function diffLines(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: 'same', lines: before.split('\n') }] : [];
  const a = before ? before.split('\n') : []; const b = after ? after.split('\n') : [];
  let prefix = 0; let suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const parts: DiffPart[] = [];
  const add = (kind: DiffPart['kind'], lines: string[]) => {
    if (!lines.length) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.lines.push(...lines); else parts.push({ kind, lines });
  };
  add('same', a.slice(0, prefix));
  const left = a.slice(prefix, a.length - suffix); const right = b.slice(prefix, b.length - suffix);
  // Bound work for large imports with extensive changes. A replacement block is
  // still an exact diff even when computing a minimal alignment would be costly.
  if ((left.length + 1) * (right.length + 1) > 1_000_000) {
    add('removed', left); add('added', right);
  } else {
    const width = right.length + 1;
    const lengths = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
      lengths[i * width + j] = left[i] === right[j] ? 1 + lengths[(i + 1) * width + j + 1] : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
    let i = 0; let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { add('same', [left[i++]]); j++; }
      else if (i < left.length && (j === right.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) add('removed', [left[i++]]);
      else add('added', [right[j++]]);
    }
  }
  add('same', a.slice(a.length - suffix));
  return parts;
}
