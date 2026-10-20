import { combineTransactionSteps, getChangedRanges } from '@tiptap/core';
import { Link as BaseLink, isAllowedUri } from '@tiptap/extension-link';
import type { Mark, MarkType, Node } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { tokenize } from 'linkifyjs';

type Span = { from: number; to: number };
type LinkRange = Span & { mark: Mark };
type Options = { type: MarkType; defaultProtocol: string; validate: (url: string) => boolean; shouldAutoLink: (url: string) => boolean };

const space = /\s/;
const links = (text: string, protocol: string) => tokenize(text).map(token => token.toObject(protocol));
// As Tiptap's autolink: one link, or one link wrapped in parentheses or brackets.
function linkToken(text: string, protocol: string) {
  const tokens = links(text, protocol);
  if (tokens.length === 1) return tokens[0].isLink ? tokens[0] : undefined;
  if (tokens.length === 3 && tokens[1].isLink && ['()', '[]'].includes(tokens[0].value + tokens[2].value)) return tokens[1];
}

// The whitespace-delimited words around [from, to] in each textblock they touch.
// Leaf nodes such as hard breaks count as whitespace.
function wordSpans(doc: Node, from: number, to: number) {
  const spans: Span[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1; const text = node.textBetween(0, node.content.size, undefined, ' ');
    let a = Math.max(0, from - start); let b = Math.min(text.length, to - start);
    while (a > 0 && !space.test(text[a - 1])) a--;
    while (b < text.length && !space.test(text[b])) b++;
    spans.push({ from: start + a, to: start + b });
    return false;
  });
  return spans;
}

// Whole link marks, not just the parts inside a span, so a link's full text is judged.
function linkRanges(doc: Node, span: Span, type: MarkType) {
  const ranges: LinkRange[] = [];
  const block = doc.resolve(span.from).parent; const start = doc.resolve(span.from).start();
  block.forEach((child, offset) => {
    const mark = type.isInSet(child.marks); const from = start + offset; const last = ranges[ranges.length - 1];
    if (!mark) return;
    if (last && last.to === from && last.mark.eq(mark)) last.to = from + child.nodeSize;
    else ranges.push({ from, to: from + child.nodeSize, mark });
  });
  return ranges.filter(range => range.from <= span.to && range.to >= span.from);
}

// A link the autolink plugin would have made: its text is the URL it points to.
function automatic(doc: Node, range: LinkRange, protocol: string) {
  const tokens = links(doc.textBetween(range.from, range.to), protocol);
  return tokens.length === 1 && tokens[0].isLink && tokens[0].href === range.mark.attrs.href;
}

// Tiptap only adds autolinks and never revisits them. When an edit touches an
// autolink, relink the edited words so a link follows the URL as it is corrected,
// and ends where the URL now ends.
function autolinkRepair(options: Options) {
  const { type, defaultProtocol: protocol } = options;
  const wanted = (doc: Node, span: Span) => {
    const result: LinkRange[] = []; const text = doc.textBetween(span.from, span.to, undefined, ' ');
    for (const match of text.matchAll(/\S+/g)) {
      const link = linkToken(match[0], protocol);
      if (!link || !options.validate(link.value) || !options.shouldAutoLink(link.value)) continue;
      const from = span.from + match.index + link.start; const to = from + link.value.length;
      if (doc.type.schema.marks.code && doc.rangeHasMark(from, to, doc.type.schema.marks.code)) continue;
      result.push({ from, to, mark: type.create({ href: link.href }) });
    }
    return result;
  };
  return new Plugin({
    key: new PluginKey('autolinkRepair'),
    appendTransaction(transactions: readonly Transaction[], oldState, newState) {
      if (!transactions.some(tr => tr.docChanged) || transactions.some(tr => tr.getMeta('preventAutolink') || tr.getMeta(ySyncPluginKey)?.isChangeOrigin)) return;
      const { tr } = newState;
      for (const { oldRange, newRange } of getChangedRanges(combineTransactionSteps(oldState.doc, [...transactions]))) {
        const old = wordSpans(oldState.doc, oldRange.from, oldRange.to).flatMap(span => linkRanges(oldState.doc, span, type));
        if (!old.length || !old.every(range => automatic(oldState.doc, range, protocol))) continue;
        for (const span of wordSpans(newState.doc, newRange.from, newRange.to)) {
          const current = linkRanges(newState.doc, span, type); const next = wanted(newState.doc, span);
          if (current.length === next.length && current.every((range, i) => range.from === next[i].from && range.to === next[i].to && range.mark.eq(next[i].mark))) continue;
          // Trim only automatic links that extend past the words being relinked.
          for (const range of current) tr.removeMark(Math.min(range.from, span.from), Math.max(range.to, span.to), type);
          for (const range of next) tr.addMark(range.from, range.to, range.mark);
        }
      }
      return tr.steps.length ? tr : undefined;
    },
  });
}

// Text typed at the end of a link does not join it.
export const Link = BaseLink.extend({
  inclusive: () => false,
  addProseMirrorPlugins() {
    const { protocols, defaultProtocol } = this.options;
    return [...(this.parent?.() ?? []), autolinkRepair({
      type: this.type, defaultProtocol, shouldAutoLink: this.options.shouldAutoLink,
      validate: url => !!this.options.isAllowedUri(url, { defaultValidate: href => !!isAllowedUri(href, protocols), protocols, defaultProtocol }),
    })];
  },
});
