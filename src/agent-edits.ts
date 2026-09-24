import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { documentSignature } from '../shared/sync';
import { typingDuration, canAnimate, highlightMs, type AgentEditEvent } from '../shared/agent-edits';

interface Effect { id: string; from: number; to: number; positions: number[]; start: number; duration: number; expires: number }
interface Effects { effects: Effect[]; seen: string[] }
const key = new PluginKey<Effects>('garnet-agent-edits');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const now = () => performance.now();
function finish(e: Effect, time: number): Effect { return { ...e, start: time, duration: 0, expires: time + highlightMs }; }
export function finishAgentEdits(editor: Editor, clear = false) {
  if (!editor.isDestroyed && key.getState(editor.state)?.effects.length) editor.view.dispatch(editor.state.tr.setMeta(key, { type: clear ? 'clear' : 'finish', time: now() }));
}
export const AgentEdits = Extension.create({
  name: 'garnetAgentEdits',
  addProseMirrorPlugins() {
    return [new Plugin<Effects>({
      key,
      state: {
        init: () => ({ effects: [], seen: [] }),
        apply(tr, previous) {
          const action = tr.getMeta(key); const time = action?.time ?? now();
          let effects = previous.effects.filter(e => e.expires > time);
          let seen = previous.seen;
          if (tr.docChanged) {
            const remote = Boolean(tr.getMeta(ySyncPluginKey));
            effects = effects.map(effect => {
              let overlap = false;
              tr.mapping.maps.forEach(map => map.forEach((from, to) => { if (from < effect.to && to > effect.from) overlap = true; }));
              const mapped = { ...effect, from: tr.mapping.map(effect.from, 1), to: tr.mapping.map(effect.to, -1), positions: effect.positions.map(p => tr.mapping.map(p, -1)) };
              mapped.to = Math.max(mapped.from, mapped.to);
              return !remote || overlap ? finish(mapped, time) : mapped;
            });
          }
          if (action?.type === 'clear') effects = [];
          if (action?.type === 'finish') effects = effects.map(e => finish(e, time));
          if (action?.type === 'add' && !seen.includes(action.id)) {
            seen = [...seen.slice(-99), action.id];
            const from = Math.max(0, Math.min(action.from, tr.doc.content.size));
            const to = Math.max(from, Math.min(action.to, tr.doc.content.size));
            // Bound segmentation work: anything beyond the two-second budget is instant.
            const positions: number[] = [];
            tr.doc.nodesBetween(from, to, (node, pos) => {
              if (positions.length > 480) return false;
              if (!node.isText) return;
              const start = Math.max(from, pos); const end = Math.min(to, pos + node.nodeSize);
              for (const part of segmenter.segment(node.text!.slice(start - pos, end - pos))) {
                positions.push(start + part.index + part.segment.length);
                if (positions.length > 480) break;
              }
            });
            const remaining = Math.max(0, ...effects.map(e => e.start + e.duration - time));
            const overlap = effects.some(e => from < e.to && to > e.from);
            const animate = action.animate && !overlap && positions.length > 0 && canAnimate(remaining, positions.length);
            if (!animate) effects = effects.map(e => finish(e, time));
            const start = time + (animate ? remaining : 0); const duration = animate ? typingDuration(positions.length) : 0;
            effects.push({ id: action.id, from, to, positions, start, duration, expires: start + duration + highlightMs });
          }
          return { effects: effects.slice(-64), seen };
        },
      },
      props: {
        decorations(state) {
          const effects = key.getState(state)?.effects || []; const time = now(); const decorations: Decoration[] = [];
          const active = effects.find(e => e.duration && time < e.start + e.duration) || effects.at(-1);
          for (const effect of effects) {
            if (effect.from < effect.to) decorations.push(Decoration.inline(effect.from, effect.to, { class: 'garnet-edit-highlight' }));
            const progress = effect.duration ? Math.max(0, Math.min(1, (time - effect.start) / effect.duration)) : 1;
            const count = Math.floor(effect.positions.length * progress);
            const at = count ? effect.positions[count - 1] : effect.from;
            if (progress < 1 && at < effect.to) decorations.push(Decoration.inline(at, effect.to, { class: 'garnet-edit-hidden' }));
            if (effect === active) {
              const caret = Math.min(state.doc.content.size, Math.max(0, progress === 1 ? effect.to : at));
              decorations.push(Decoration.widget(caret, () => {
                const cursor = document.createElement('span'); cursor.className = 'collaboration-carets__caret garnet-agent-caret'; cursor.contentEditable = 'false'; cursor.dataset.position = String(caret); cursor.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span'); label.className = 'collaboration-carets__label'; label.textContent = 'Garnet'; cursor.append(label); return cursor;
              }, { side: -1, key: `${effect.id}:${caret}` }));
            }
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
      view(view) {
        let frame = 0;
        const tick = () => { frame = 0; if (key.getState(view.state)?.effects.length) view.dispatch(view.state.tr.setMeta(key, { type: 'tick', time: now() })); };
        const finishAll = () => { if (key.getState(view.state)?.effects.length) view.dispatch(view.state.tr.setMeta(key, { type: document.hidden ? 'clear' : 'finish', time: now() })); };
        const motion = matchMedia('(prefers-reduced-motion: reduce)');
        for (const event of ['keydown', 'pointerdown', 'copy', 'cut', 'paste', 'compositionstart']) view.dom.addEventListener(event, finishAll);
        document.addEventListener('visibilitychange', finishAll); motion.addEventListener('change', finishAll);
        return {
          update() { if (!frame && key.getState(view.state)?.effects.length) frame = requestAnimationFrame(tick); },
          destroy() { cancelAnimationFrame(frame); for (const event of ['keydown', 'pointerdown', 'copy', 'cut', 'paste', 'compositionstart']) view.dom.removeEventListener(event, finishAll); document.removeEventListener('visibilitychange', finishAll); motion.removeEventListener('change', finishAll); },
        };
      },
    })];
  },
});
export function showAgentEdit(editor: Editor, doc: Y.Doc, event: AgentEditEvent, visible: () => boolean) {
  const deadline = now() + 250;
  const show = () => {
    if (editor.isDestroyed || !visible() || document.hidden) return;
    // Stateless messages can arrive just before Hocuspocus flushes the Yjs update.
    if (documentSignature(doc) !== event.signature) { if (now() < deadline) requestAnimationFrame(show); return; }
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    if (!binding) return;
    const from = relativePositionToAbsolutePosition(doc, doc.getXmlFragment('default'), Y.createRelativePositionFromJSON(event.from), binding.mapping);
    const to = relativePositionToAbsolutePosition(doc, doc.getXmlFragment('default'), Y.createRelativePositionFromJSON(event.to), binding.mapping);
    if (from === null || to === null) return;
    editor.view.dispatch(editor.state.tr.setMeta(key, { type: 'add', id: event.id, from, to, time: now(), animate: event.textChanged && !matchMedia('(prefers-reduced-motion: reduce)').matches }));
  };
  show();
}
