import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence } from 'y-indexeddb';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import { extensions, filename } from '../shared/editor';
import type { User, DocMeta } from '../shared/types';
import { documentSignature } from '../shared/sync';
import { diffLines, type SavedRevision } from '../shared/history';
import { api, csrf, setCsrf, toast, escape, dialog, download } from './api';
import { unb64 } from './base64';
import * as cache from './db';

// Metadata stays in memory; content (base64 Yjs state and Markdown) lives in the 'content' store.
interface CachedDoc extends DocMeta { cached?: boolean; dirty?: boolean; localOnly?: boolean }
interface Content { id: string; state: string; markdown?: string }
// Carets use the document's own awareness, so an editor can show them before the provider connects.
interface OpenDoc { doc: Y.Doc; persistence: IndexeddbPersistence; awareness: Awareness; provider?: import('@hocuspocus/provider').HocuspocusProvider; touched: number; timer?: ReturnType<typeof setTimeout>; generation: number; pendingSince?: number; ready?: Promise<void> }
interface Operation { id: string; version: string; path: string; method: string; body: any; createdAt: number }
type Session = { user: User; csrf: string };
const records = new Map<string, CachedDoc>();
const opened = new Map<string, OpenDoc>();
// Recently viewed editors stay alive off the page, so returning to a document skips
// rebuilding its schema, plugins and DOM. Least recently viewed first.
interface LiveEditor { editor: Editor; awareness: Awareness; words?: string }
const editors = new Map<string, LiveEditor>(); const keptEditors = 4;
let user: User; let editor: Editor | undefined; let activeId = ''; let currentOpen = 0;
// The document whose title the title field shows. A new one's shows before it finishes opening.
let titleId = '';
let prefs: Record<string, any> = {}; let preferenceTimer: ReturnType<typeof setTimeout>; let changedPrefs: Record<string, any> = {};
let syncRunning = false; let syncAgain = false; let online = navigator.onLine; let events: EventSource | undefined; let searchQuery = ''; let matches: Set<string> | null = null;
let localError = false; let showingTrash = false; let startupSession: Promise<Session> | undefined;
// Search, local snapshots and Markdown conversion run in this worker. Its code repeats Yjs,
// Tiptap and the Markdown parser, so it starts once the first document is on screen.
let worker: Worker | undefined; const unsent: unknown[] = [];
const replies = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>(); let requests = 0;
function post(message: unknown) { if (worker) worker.postMessage(message); else unsent.push(message); }
function ask<T>(message: Record<string, unknown>) {
  const request = ++requests; post({ ...message, request });
  return new Promise<T>((resolve, reject) => replies.set(request, { resolve, reject }));
}
function startWorker() {
  if (worker) return;
  worker = new Worker(new URL('./library.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'reply') { const reply = replies.get(data.request)!; replies.delete(data.request); if (data.error === undefined) reply.resolve(data.value); else reply.reject(new Error(data.error)); }
    if (data.type === 'results' && data.query === searchQuery) { matches = searchQuery.trim() ? new Set(data.ids) : null; renderList(); }
  };
  worker.onerror = () => { for (const reply of replies.values()) reply.reject(new Error('The background worker stopped.')); replies.clear(); };
  for (const message of unsent.splice(0)) worker.postMessage(message);
}
// Coalesces bursts of calls (keystrokes, scroll events) into one call after `ms` of quiet.
function debounce(run: () => void, ms: number) { let timer: ReturnType<typeof setTimeout> | undefined; const call = () => { clearTimeout(timer); timer = setTimeout(run, ms); }; call.cancel = () => clearTimeout(timer); return call; }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
function localFailure(error: any) { localError = true; status('local-error'); toast(`Local storage: ${error.message}. Export your notes before closing this page.`); }
async function persist(record: CachedDoc) { try { await cache.put('docs', record.id, { ...record }); } catch (error) { localFailure(error); throw error; } }
async function store(id: string, content: Omit<Content, 'id'>) { try { await cache.put('content', id, { id, state: content.state, markdown: content.markdown }); } catch (error) { localFailure(error); throw error; } }
const stored = (id: string) => cache.get<Content>('content', id);
const index = (id: string, title: string, markdown?: string) => post({ type: 'index', docs: [{ id, title, markdown }] });
function markPreference(key: string, value: any) {
  prefs[key] = value; changedPrefs[key] = value;
  cache.put('prefs', 'values', prefs).catch(localFailure);
  clearTimeout(preferenceTimer); preferenceTimer = setTimeout(() => {
    const body = changedPrefs; changedPrefs = {};
    void enqueue('/preferences', 'PATCH', body);
  }, 750);
}
// A returning user starts from the cached account; `session` is the page's check
// of it, which the first sync uses instead of asking again.
export async function start(account: User, session?: Promise<Session>) {
  user = account; startupSession = session;
  await cache.openCache(user.id, { blocked: () => toast('Close other Garnet tabs to finish updating this one.'), replaced: () => toast('Garnet was updated in another tab. Reload this page to keep editing.') });
  for (const record of await cache.all<CachedDoc>('docs')) records.set(record.id, record);
  prefs = await cache.get('prefs', 'values') || {};
  document.documentElement.dataset.theme = prefs.theme || 'system';
  // Measure before building the workspace so reading the viewport doesn't force a layout of it.
  const updateViewport = () => {
    const viewport = window.visualViewport;
    if (viewport && viewport.scale === 1) document.documentElement.style.setProperty('--visible-height', `${viewport.height}px`);
  };
  window.visualViewport?.addEventListener('resize', updateViewport);
  updateViewport();
  $('#app').innerHTML = `<div class="workspace"><dialog id="navigation" aria-label="Navigation"><aside id="sidebar"><div class="sidebar-top"><label class="search-label"><span class="sr-only">Search documents</span><input id="search" type="search" placeholder="Search your notes…" autocomplete="off"></label><kbd>⌘ K</kbd><button id="collapse" class="icon-button" autofocus title="Close navigation (Esc)" aria-label="Close navigation">×</button></div><div class="list-heading"><span id="list-label">YOUR DOCUMENTS</span><span id="doc-count"></span></div><nav id="doc-list" aria-label="Documents"></nav><div id="document-menu" class="menu-dropdown"></div><div class="sidebar-bottom"><button id="trash-button">Trash</button><button id="account-button" title="Account">${escape(user.username)}</button></div><div id="sync-error" class="sync-error" hidden></div></aside></dialog><main id="main"><header class="document-header"><div class="document-menu"><button id="menu-button" class="icon-button" aria-label="Open menu" aria-expanded="false" aria-controls="navigation" aria-haspopup="dialog"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button></div><div class="header-actions"><button id="ai-button" class="ai-button">Ask AI <kbd>⌘ J</kbd></button></div></header><div id="empty"><div class="empty-mark">Garnet</div><h1>Room to think.</h1><p>A quick note, a rough idea, a shared draft.<br>Choose a document or start a fresh page.</p><button class="primary" id="empty-new">New document</button></div><section id="document" hidden><input id="document-title" aria-label="Document title" placeholder="Untitled" maxlength="200"><div id="toolbar" role="toolbar" aria-label="Formatting"><button data-command="bold" title="Bold (Ctrl+B)"><strong>B</strong></button><button data-command="italic" title="Italic (Ctrl+I)"><em>I</em></button><button data-command="strike" title="Strikethrough"><s>S</s></button><span class="toolbar-divider"></span><button data-command="heading" title="Heading">H2</button><button data-command="bulletList" title="Bullet list">List</button><button data-command="orderedList" title="Numbered list">1.</button><button data-command="taskList" title="Checklist">Tasks</button><button data-command="blockquote" title="Quote">Quote</button><button data-command="codeBlock" title="Code block">Code</button><button data-command="link" title="Insert link">Link</button><button data-command="table" title="Insert table">Table</button><span class="toolbar-divider"></span><button data-command="undo" title="Undo">↶</button><button data-command="redo" title="Redo">↷</button></div><div id="editor-mount"></div><footer class="document-footer"><span id="word-count"></span><span id="people"></span></footer></section></main><aside id="ai-panel" hidden></aside></div>`;
  $('#empty-new').onclick = () => void newDocument();
  $('#collapse').onclick = () => closeMenu();
  $('#search').oninput = () => { searchQuery = ($<HTMLInputElement>('#search')).value; post({ type: 'search', query: searchQuery }); };
  $('#trash-button').onclick = () => { showingTrash = !showingTrash; $('#trash-button').classList.toggle('selected', showingTrash); renderList(); };
  $('#account-button').onclick = () => { closeMenu(); showAccount(); };
  const navigation = $<HTMLDialogElement>('#navigation');
  $('#menu-button').onclick = () => { if (navigation.open) closeMenu(); else documentOptions(); };
  navigation.addEventListener('close', () => $('#menu-button').setAttribute('aria-expanded', 'false'));
  navigation.addEventListener('pointerdown', e => {
    if (e.target !== navigation) return;
    const rect = navigation.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) closeMenu();
  });
  navigation.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      const targets = [...navigation.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled)')].filter(el => el.getClientRects().length);
      const first = targets[0]; const last = targets.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      return;
    }
    if (!(e.target instanceof HTMLButtonElement) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const buttons = [...navigation.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  });
  $('#menu-button').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); documentOptions(); }
  });
  $('#doc-list').addEventListener('click', e => {
    const target = e.target as Element; const pin = target.closest<HTMLButtonElement>('[data-pin]'); const row = target.closest<HTMLButtonElement>('[data-id]');
    if (pin) {
      const id = pin.dataset.pin!; const pins: string[] = prefs.pins || [];
      markPreference('pins', pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id]);
      renderList(); $('#doc-list').querySelector<HTMLButtonElement>(`[data-pin="${id}"]`)?.focus();
    } else if (row && showingTrash) {
      const id = row.dataset.id!; const d = dialog('Restore document', `<p>${escape(records.get(id)!.title)}</p><button class="primary" id="restore-trash">Restore</button>`);
      d.querySelector('#restore-trash')!.addEventListener('click', () => { void setDeleted(id, false); d.close(); });
    } else if (row) void openDocument(row.dataset.id!);
  });
  $('#ai-button').onclick = () => void toggleAI();
  $('#document-title').oninput = () => {
    const id = titleId; const record = records.get(id); if (!record) return; record.title = $<HTMLInputElement>('#document-title').value || 'Untitled';
    persist(record).catch(() => {}); renderList(); index(id, record.title);
    void enqueue(`/documents/${id}`, 'PATCH', { title: record.title, opId: crypto.randomUUID() });
  };
  $('#toolbar').addEventListener('mousedown', e => { if ((e.target as Element).closest('button')) e.preventDefault(); });
  $('#toolbar').addEventListener('click', e => { const button = (e.target as Element).closest<HTMLButtonElement>('button[data-command]'); if (button && editor) command(button.dataset.command!); });
  $('#main').addEventListener('scroll', saveCursorSoon, { passive: true });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); documentOptions(); $<HTMLInputElement>('#search').focus(); }
    if ((e.altKey && e.key.toLowerCase() === 'n') || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n')) { e.preventDefault(); void newDocument(); }
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); if ($<HTMLDialogElement>('#navigation').open) closeMenu(); else documentOptions(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); void toggleAI(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushActive().catch(e => toast(e.message)); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { saveCursor(); void flushLocal(); opened.get(activeId)?.provider?.sendStateless('flush'); } });
  window.addEventListener('beforeunload', e => { if (localError) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('offline', () => { online = false; status(); });
  window.addEventListener('online', () => { void synchronize(); });
  renderList(); post({ type: 'index', docs: [...records.values()].map(({ id, title }) => ({ id, title })) });
  post({ type: 'load', database: `ed:${user.id}` });
  const hashId = location.hash.slice(1);
  const available = (id: string | undefined) => id && records.has(id) && !records.get(id)!.deletedAt && !records.get(id)!.purgedAt;
  window.addEventListener('hashchange', () => {
    const linked = location.hash.slice(1); const record = records.get(linked);
    // A known document that has not downloaded needs the server. Offline, as far as this page knows, it waits for sync.
    const waiting = record && !record.cached && !record.localOnly && !online;
    if (!waiting) { const target = available(linked) ? linked : prefs.lastDocument; if (available(target)) void openDocument(target, false); }
    // As at startup, a linked document this device does not have yet opens when
    // sync brings it, unless another document was chosen in the meantime.
    if (linked && (!record || waiting)) {
      const since = currentOpen;
      wantedDocument = { id: () => linked, restore: async () => { if (currentOpen === since && available(linked)) await openDocument(linked, false); } };
      void synchronize();
    }
  });
  const initial = hashId || prefs.lastDocument;
  let startupOpen = currentOpen;
  if (available(initial)) {
    const opening = openDocument(initial, false);
    startupOpen = currentOpen;
    await opening;
  }
  requestAnimationFrame(() => setTimeout(startWorker));
  // A new device only learns lastDocument during sync. Never override a user
  // selection (including one still loading) with this delayed startup choice.
  // Sync downloads the wanted document first and restores it before the rest of the library.
  const restore = async () => {
    if (activeId || currentOpen !== startupOpen) return;
    const restored = available(hashId) ? hashId : prefs.lastDocument;
    if (available(restored)) await openDocument(restored, false);
  };
  const startup = { id: () => hashId || prefs.lastDocument, restore }; wantedDocument = startup;
  await synchronize();
  if (wantedDocument === startup) wantedDocument = undefined;
  await restore();
  setInterval(() => void synchronize(), 20000);
}
function status(message?: 'local-error' | 'saving' | 'auth-required') {
  const d = records.get(activeId); const main = $('#main');
  const next = !d ? (online ? 'idle' : 'offline') : message || (localError ? 'local-error' : !online ? 'offline' : d.dirty || d.localOnly ? 'syncing' : 'saved');
  if (main.dataset.saveState !== next) main.dataset.saveState = next;
}
// The list lives in the navigation dialog, so it is only drawn while the dialog is open.
let listStale = true;
function renderList() {
  window.dispatchEvent(new Event('ed-documents'));
  listStale = true;
  if ($<HTMLDialogElement>('#navigation').open) drawList();
}
function drawList() {
  listStale = false;
  const pins = new Set<string>(prefs.pins || []);
  const docs = [...records.values()].filter(d => !d.purgedAt && Boolean(d.deletedAt) === showingTrash && (!matches || matches.has(d.id))).sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.updatedAt - a.updatedAt);
  $('#list-label').textContent = showingTrash ? 'TRASH' : searchQuery ? 'SEARCH RESULTS' : 'YOUR DOCUMENTS'; $('#doc-count').textContent = String(docs.length);
  $('#doc-list').innerHTML = docs.length ? docs.map(d => `<div class="doc-item ${d.id === activeId ? 'active' : ''}"><button class="doc-row ${d.id === activeId ? 'active' : ''}" data-id="${d.id}" ${d.id === activeId ? 'aria-current="page"' : ''}><span class="document-glyph" aria-hidden="true">≡</span><span class="doc-name">${escape(d.title)}</span>${d.dirty || d.localOnly ? '<span class="pending-dot" title="Pending sync"></span>' : ''}</button>${showingTrash ? '' : `<button class="pin-button" data-pin="${d.id}" aria-label="${pins.has(d.id) ? 'Unpin' : 'Pin'} ${escape(d.title)}" aria-pressed="${pins.has(d.id)}" title="${pins.has(d.id) ? 'Unpin' : 'Pin to top'}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6v6l3 3v3H6v-3l3-3V3M12 15v6"/></svg></button>`}</div>`).join('') : `<p class="list-empty">${searchQuery ? 'No matching documents.' : showingTrash ? 'Trash is empty.' : 'Your first note starts here.'}</p>`;
}
let lastOperation = 0;
async function enqueue(url: string, method: string, body: any) {
  // Strictly increasing, so operations queued in the same millisecond still sync in order.
  const createdAt = lastOperation = Math.max(Date.now(), lastOperation + 1);
  const operation: Operation = { id: method === 'PATCH' && body.title !== undefined ? `rename-${url.split('/')[2]}` : crypto.randomUUID(), version: crypto.randomUUID(), path: url, method, body, createdAt };
  // Push only: server changes arrive as events, and pulling the whole library for every queued edit is wasted work.
  try { await cache.put('ops', operation.id, operation); void synchronize(false); } catch (error) { localFailure(error); }
}
async function newDocument(title = 'Untitled', initialMarkdown?: string) {
  const id = crypto.randomUUID(); const record: CachedDoc = { id, title, createdAt: Date.now(), updatedAt: Date.now(), revision: 0, mirrorRevision: -1, deletedAt: null, localOnly: true, dirty: true };
  // The worker converts and stores imported Markdown before the document opens and reads it.
  if (initialMarkdown !== undefined) { await ask({ type: 'import', id, markdown: initialMarkdown }); record.cached = true; }
  records.set(id, record); renderList(); index(id, title);
  // Queue the creation now: a rename typed straight away must reach the server after it.
  const persistTask = persist(record); const creating = enqueue('/documents', 'POST', { id, title });
  const naming = title === 'Untitled';
  void openDocument(id, !naming).then(() => { if (activeId === id && !naming) editor?.commands.focus('end'); });
  if (naming) {
    // Take typing in the new title at once, rather than in the previous document until this one opens.
    closeMenu(false); hideEditor(); $('#empty').hidden = true; $('#document').hidden = false;
    const input = $<HTMLInputElement>('#document-title'); input.value = title; titleId = id; input.focus(); input.select();
  }
  await persistTask; await creating; return id;
}
async function getOpen(id: string): Promise<OpenDoc> {
  let existing = opened.get(id); if (existing) { existing.touched = Date.now(); await existing.ready; return existing; }
  const doc = new Y.Doc(); const persistence = new IndexeddbPersistence(`ed:${user.id}:doc:${id}`, doc);
  const entry: OpenDoc = { doc, persistence, awareness: new Awareness(doc), touched: Date.now(), generation: 0 }; opened.set(id, entry);
  entry.ready = (async () => {
    // The saved snapshot and y-indexeddb's updates load in parallel; Yjs merges them in any order.
    const saved = records.get(id)?.cached ? await stored(id).catch(() => undefined) : undefined;
    if (saved?.state) Y.applyUpdate(doc, unb64(saved.state));
    await persistence.whenSynced;
    // The worker loads the same stored state itself, then mirrors every later update.
    post({ type: 'open', id });
    doc.on('update', (update: Uint8Array) => {
      post({ type: 'update', id, update });
      entry.generation++; const current = records.get(id); if (!current) return;
      // y-indexeddb has already stored this update; record that the document awaits sync.
      if (!current.dirty) { current.dirty = true; persist(current).catch(() => {}); }
      if (id === activeId) status('saving');
      scheduleSave(id, entry);
    });
    connect(id, entry);
  })();
  await entry.ready; return entry;
}
// A snapshot re-encodes the whole document for the offline copy, search and export.
// The worker does it when typing pauses, and at least every five seconds.
function scheduleSave(id: string, entry: OpenDoc) {
  clearTimeout(entry.timer); entry.pendingSince ??= Date.now();
  const delay = Math.max(0, Math.min(1000, entry.pendingSince + 5000 - Date.now()));
  entry.timer = setTimeout(() => void saveLocal(id).catch(() => {}), delay);
}
// The provider's code loads when the first document connects, after it has opened from the local copy.
let Provider: typeof import('@hocuspocus/provider').HocuspocusProvider | undefined;
function connect(id: string, entry: OpenDoc) {
  const record = records.get(id); if (!online || !csrf || entry.provider || opened.get(id) !== entry || record?.localOnly || record?.deletedAt) return;
  if (!Provider) { import('@hocuspocus/provider').then(module => { Provider = module.HocuspocusProvider; connect(id, entry); }, () => {}); return; }
  const provider = new Provider({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collaboration`, name: id, document: entry.doc, awareness: entry.awareness, token: () => csrf,
    onSynced: () => { provider.sendStateless('flush'); },
    onAuthenticationFailed: () => { if (id === activeId) status('auth-required'); },
    onStateless: async ({ payload }) => {
      const event = JSON.parse(payload);
      if (event.type !== 'persisted') return;
      const generation = entry.generation; const signature = documentSignature(entry.doc);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hash === event.stateHash && generation === entry.generation) {
        const d = records.get(id)!; d.dirty = false; await saveLocal(id); if (id === activeId) status(); renderList();
      }
    },
    onAwarenessUpdate: () => { if (id === activeId) showPeople(entry.awareness); },
  });
  entry.provider = provider;
}
// Destroying a provider destroys its awareness too, so the next connection gets a fresh one.
function disconnect(entry: OpenDoc) {
  if (!entry.provider) return;
  entry.provider.destroy(); entry.provider = undefined; entry.awareness = new Awareness(entry.doc);
}
function showPeople(awareness: Awareness) {
  const names = [...awareness.getStates().values()].map((s: any) => s.user?.name).filter(Boolean);
  const people = names.length > 1 ? `${names.length} people here` : ''; if ($('#people').textContent !== people) $('#people').textContent = people;
}
async function saveLocal(id: string) {
  const entry = opened.get(id); if (!entry || !records.has(id)) return;
  clearTimeout(entry.timer); entry.timer = undefined; entry.pendingSince = undefined;
  // The worker stores a snapshot (and indexes its text) only if the document changed since the last one.
  let saved: boolean;
  try { saved = await ask<boolean>({ type: 'save', id }); } catch (error) { localFailure(error); throw error; }
  // Sync may have replaced the record object in the meantime.
  const record = records.get(id); if (!record) return;
  if (saved) record.cached = true;
  await persist(record);
  if (id === activeId) status();
}
async function flushLocal() { await Promise.all([...opened.keys()].map(saveLocal)); }
async function openDocument(id: string, focus = true) {
  // The previous document's snapshot stays scheduled; y-indexeddb already holds its edits.
  const count = ++currentOpen; saveCursor();
  const record = records.get(id); if (!record) return;
  if (!record.cached && !record.localOnly) {
    if (!online) { toast('This document has not finished downloading for offline use.'); return; }
    try { await fetchState(id); } catch (error: any) { toast(error.message); return; }
  }
  const entry = await getOpen(id); if (count !== currentOpen) return;
  hideEditor(); activeId = id; markPreference('lastDocument', id); history.replaceState(null, '', `#${id}`);
  $('#empty').hidden = true; $('#document').hidden = false;
  const title = $<HTMLInputElement>('#document-title'); if (titleId !== id || document.activeElement !== title) title.value = record.title; titleId = id;
  if (focus) closeMenu(false);
  // An editor built before its document's provider was replaced holds a destroyed awareness.
  let live = editors.get(id); if (live && live.awareness !== entry.awareness) { dropEditor(id); live = undefined; }
  const reused = Boolean(live); live ??= createEditor(entry);
  editors.delete(id); editors.set(id, live); editor = live.editor;
  $('#editor-mount').replaceChildren(editor.view.dom); keepEditorStyle();
  restoreCursor(focus, reused); $('#word-count').textContent = live.words ?? ''; if (live.words === undefined) countWordsSoon();
  updateToolbar(); showPeople(entry.awareness); renderList(); status();
  if ($<HTMLDialogElement>('#navigation').open) documentOptions();
  for (const key of editors.keys()) if (editors.size > keptEditors && key !== activeId) dropEditor(key);
  while (opened.size > 8) {
    const candidate = [...opened].filter(([key, value]) => key !== activeId && !records.get(key)?.dirty).sort((a, b) => a[1].touched - b[1].touched)[0];
    if (!candidate) break; const [key, closing] = candidate;
    await saveLocal(key); dropEditor(key); closing.provider?.destroy(); closing.awareness.destroy(); await closing.persistence.destroy(); closing.doc.destroy(); opened.delete(key); post({ type: 'close', id: key });
  }
}
function createEditor(entry: OpenDoc) {
  const live = { awareness: entry.awareness } as LiveEditor;
  live.editor = new Editor({ extensions: [...extensions(), Collaboration.configure({ document: entry.doc }), CollaborationCaret.configure({ provider: { awareness: entry.awareness }, user: { name: user.username, color: ['#557a59', '#617daf', '#ab6f47', '#9275a9'][user.username.charCodeAt(0) % 4] } })], editorProps: { attributes: { class: 'prose', spellcheck: 'true', 'aria-label': 'Document content', 'data-placeholder': 'Start writing…', role: 'textbox', 'aria-multiline': 'true' } },
    // Kept editors still apply collaborators' edits; only the visible one updates the page.
    onUpdate: () => { live.words = undefined; if (live.editor === editor) countWordsSoon(); },
    onSelectionUpdate: () => { if (live.editor === editor) { saveCursorSoon(); updateToolbar(); } },
  });
  return live;
}
// Tiptap removes its shared stylesheet when an editor is destroyed with no other on
// the page, and a kept editor can return after that.
let editorStyle: HTMLStyleElement | null = null;
function keepEditorStyle() {
  const current = document.querySelector<HTMLStyleElement>('style[data-tiptap-style]');
  if (current) editorStyle = current; else if (editorStyle) document.head.append(editorStyle);
}
// Takes the visible editor off the page, keeping it alive for a quick return.
function hideEditor() {
  if (!editor) return;
  if (editor.view.hasFocus()) editor.view.dom.blur();
  editor.view.dom.remove(); editor = undefined;
  // Collaborators should not see a caret in a document this person has left.
  editors.get(activeId)?.awareness.setLocalStateField('cursor', null);
}
function dropEditor(id: string) {
  const live = editors.get(id); if (!live) return;
  editors.delete(id); if (live.editor === editor) editor = undefined;
  live.editor.destroy();
}
// Selection and scroll changes arrive on every keystroke; remember the cursor once they settle.
const saveCursorSoon = debounce(() => saveCursor(), 400);
function saveCursor() {
  saveCursorSoon.cancel();
  if (!editor || !activeId || editor.isDestroyed) return;
  const sync = ySyncPluginKey.getState(editor.state); if (!sync?.binding) return;
  try {
    const anchor = absolutePositionToRelativePosition(editor.state.selection.anchor, sync.type, sync.binding.mapping);
    const head = absolutePositionToRelativePosition(editor.state.selection.head, sync.type, sync.binding.mapping);
    markPreference(`cursor_${activeId}`, { anchor: Y.relativePositionToJSON(anchor), head: Y.relativePositionToJSON(head), scroll: $('#main').scrollTop });
  } catch { /* The initial editor transaction may not yet have a mapping. */ }
}
// A kept editor still has its selection and layout; a new one starts from the saved
// position and scrolls once its content has rendered.
function restoreCursor(focus: boolean, reused: boolean) {
  const saved = prefs[`cursor_${activeId}`];
  if (!reused) {
    const sync = ySyncPluginKey.getState(editor!.state); let anchor = 1; let head = 1;
    if (saved && sync?.binding) {
      anchor = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(saved.anchor), sync.binding.mapping) ?? 1;
      head = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(saved.head), sync.binding.mapping) ?? anchor;
    }
    const max = editor!.state.doc.content.size; editor!.commands.setTextSelection({ from: Math.min(anchor, max), to: Math.min(head, max) });
  }
  if (focus) editor!.commands.focus(undefined, { scrollIntoView: false });
  if (reused) $('#main').scrollTop = saved?.scroll || 0; else requestAnimationFrame(() => { $('#main').scrollTop = saved?.scroll || 0; });
}
// Counting walks the whole document, so it waits for a pause in typing. A kept editor remembers its count.
const countWordsSoon = debounce(() => updateWordCount(), 300);
function updateWordCount() {
  if (!editor || editor.isDestroyed) return;
  const text = editor.getText().trim(); const words = `${text ? text.split(/\s+/).length : 0} words`; $('#word-count').textContent = words;
  const live = editors.get(activeId); if (live?.editor === editor) live.words = words;
}
let toolbarFrame = 0;
function updateToolbar() {
  if (toolbarFrame) return;
  toolbarFrame = requestAnimationFrame(() => {
    toolbarFrame = 0; if (!editor || editor.isDestroyed) return;
    for (const button of $('#toolbar').querySelectorAll<HTMLButtonElement>('[data-command]')) {
      const pressed = String(editor.isActive(button.dataset.command!)); if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
    }
  });
}
function command(name: string) {
  const chain = editor!.chain().focus();
  const commands: Record<string, () => any> = { bold: () => chain.toggleBold().run(), italic: () => chain.toggleItalic().run(), strike: () => chain.toggleStrike().run(), heading: () => chain.toggleHeading({ level: 2 }).run(), bulletList: () => chain.toggleBulletList().run(), orderedList: () => chain.toggleOrderedList().run(), taskList: () => chain.toggleTaskList().run(), blockquote: () => chain.toggleBlockquote().run(), codeBlock: () => chain.toggleCodeBlock().run(), undo: () => chain.undo().run(), redo: () => chain.redo().run(), table: () => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), link: () => {
    const d = dialog('Link', '<form><label>URL<input name="url" type="url" required placeholder="https://"></label><button class="primary">Apply link</button><button type="button" id="remove-link">Remove link</button></form>');
    d.querySelector('form')!.onsubmit = e => { e.preventDefault(); const url = String(new FormData(e.currentTarget as HTMLFormElement).get('url')); if (!/^https?:\/\//i.test(url)) return toast('Use an HTTP or HTTPS link.'); editor!.chain().focus().setLink({ href: url }).run(); d.close(); };
    d.querySelector('#remove-link')!.addEventListener('click', () => { editor!.chain().focus().unsetLink().run(); d.close(); });
  } };
  commands[name]?.(); updateToolbar();
}
async function fetchState(id: string) {
  const remote = await api(`/documents/${id}/state`); if (!records.has(id)) return;
  const entry = opened.get(id);
  if (entry) { await entry.ready; Y.applyUpdate(entry.doc, unb64(remote.state), 'remote-fetch'); await saveLocal(id); return; }
  // Pending local edits merge with the server's state in the worker, which also converts and indexes the result.
  const merge = records.get(id)!.dirty && records.get(id)!.cached;
  if (merge) await ask({ type: 'merge', id, state: remote.state }).catch(error => { localFailure(error); throw error; });
  else await store(id, { state: remote.state, markdown: remote.markdown });
  const record = records.get(id); if (!record) return;
  record.cached = true; await persist(record);
  if (!merge) index(id, record.title, remote.markdown);
}
let pullRequested = false; let pullRunning = false; let remoteChanges = Promise.resolve();
let wantedDocument: { id: () => string | undefined; restore: () => Promise<void> } | undefined;
const metaKeys = ['title', 'createdAt', 'updatedAt', 'deletedAt', 'revision', 'mirrorRevision', 'filename', 'purgedAt', 'localOnly'] as const;
const pendingDocuments = async () => new Set((await cache.all<Operation>('ops')).filter(o => o.path.startsWith('/documents/')).map(o => o.path.split('/')[2]));
// Pushes queued operations and, unless `pull` is false, merges the server's library.
async function synchronize(pull = true) {
  pullRequested ||= pull;
  if (syncRunning) { syncAgain = true; return; }
  // The page's own session check answers the first sync. Offline, it is stale by the time a sync can run.
  const startup = startupSession; startupSession = undefined;
  if (!navigator.onLine) { return; } syncRunning = true; syncAgain = false;
  const pulling = pullRequested || !online; pullRequested = false;
  try {
    if (pulling || !csrf || startup) {
      const me: Session = await (startup ?? api('/me'));
      // The page started as the cached account, or the account must set a new password (as after a
      // reinstall, whose sign-in this or another tab just made). Reload as the one the server reports.
      if (startup || me.user.mustChangePassword) {
        let saved = true; try { localStorage.setItem('ed-user', JSON.stringify(me.user)); } catch { saved = false; }
        // Reloading without the new account saved would start as the cached one again.
        if (saved && (me.user.id !== user.id || me.user.mustChangePassword)) { location.reload(); return; }
      }
      if (me.user.id !== user.id) throw new Error('Account changed. Reload this page.');
      if (startup) Object.assign(user, me.user);
      setCsrf(me.csrf); online = true; $('#sync-error').hidden = true;
      for (const [id, entry] of opened) connect(id, entry);
    }
    const pendingCreates = new Set((await cache.all<Operation>('ops')).filter(o => o.path === '/documents').map(o => o.body.id));
    for (const record of records.values()) if (record.localOnly && !pendingCreates.has(record.id)) await enqueue('/documents', 'POST', { id: record.id, title: record.title });
    const ops = (await cache.all<Operation>('ops')).sort((a, b) => a.createdAt - b.createdAt);
    for (const op of ops) {
      try {
        const result = await api(op.path, op.method, op.body);
        if (op.path === '/documents' && records.has(result.id)) { records.get(result.id)!.localOnly = false; await persist(records.get(result.id)!); }
        if ((await cache.get<Operation>('ops', op.id))?.version === op.version) { await cache.remove('ops', op.id); }
      } catch (error: any) { if (error.status === 400 || error.status === 404) { toast(`Could not sync an action: ${error.message}`); await cache.put('prefs', `failed_${op.id}`, op); await cache.remove('ops', op.id); } else throw error; }
    }
    if (pulling) {
      pullRunning = true; await remoteChanges;
      const serverPrefs = await api('/preferences'); prefs = { ...serverPrefs, ...prefs }; await cache.put('prefs', 'values', prefs);
      const remote: DocMeta[] = await api('/documents');
      const changed = await pendingDocuments();
      // Download a document being restored on a new device, or a link to one not yet downloaded, first and open it before the rest of the library.
      const wanted = wantedDocument?.id();
      for (const d of wanted ? [...remote].sort((a, b) => Number(b.id === wanted) - Number(a.id === wanted)) : remote) {
        await applyRemote(d, changed);
        if (d.id === wanted && wantedDocument) { const { restore } = wantedDocument; wantedDocument = undefined; void restore(); }
      }
    }
    // Documents just created or restored on the server can now connect.
    for (const [id, record] of records) {
      if (record.deletedAt || record.localOnly) continue;
      if (record.dirty) await getOpen(id);
      const entry = opened.get(id); if (entry) connect(id, entry);
    }
    if (!events) {
      events = new EventSource('/api/events');
      events.addEventListener('document', e => {
        const d: DocMeta = JSON.parse((e as MessageEvent).data); const current = records.get(d.id);
        if (current && current.revision === d.revision && current.deletedAt === d.deletedAt) return;
        // Apply just this document. A pull already in progress may have missed it, so pull again after it.
        if (pullRunning) { void synchronize(); return; }
        remoteChanges = remoteChanges.then(async () => { await applyRemote(d, await pendingDocuments()); renderList(); status(); }).catch(() => void synchronize());
      });
      events.addEventListener('mirror-error', e => { const d = JSON.parse((e as MessageEvent).data); toast(d.error); });
      events.addEventListener('agent', e => window.dispatchEvent(new CustomEvent('ed-agent', { detail: JSON.parse((e as MessageEvent).data) })));
      events.onerror = () => { online = false; status(); };
      events.onopen = () => { online = true; status(); };
    }
    renderList(); status();
  } catch (error: any) {
    pullRequested ||= pulling; online = false;
    if (error.status === 401) {
      status('auth-required'); $('#sync-error').hidden = false; $('#sync-error').innerHTML = '<button id="reauth">Sign in to sync your local changes</button>'; $('#reauth').onclick = reauthenticate;
      // The session expired while the app was closed: ask now, over the documents that opened from the local copy.
      if (startup) reauthenticate();
    } else { status(); }
  } finally { syncRunning = false; pullRunning = false; if (online && (syncAgain || (await cache.all('ops')).length)) setTimeout(() => void synchronize(pullRequested), 250); }
}
// Merges one document's server metadata into the local copy.
async function applyRemote(d: DocMeta, pending: Set<string>) {
  const existing = records.get(d.id);
  if (d.deletedAt && existing?.dirty && !existing.deletedAt) await recoverDeleted(existing);
  const next = { ...existing, ...d, localOnly: false } as CachedDoc;
  if (pending.has(d.id) && existing) { next.title = existing.title; next.deletedAt = existing.deletedAt; }
  records.set(d.id, next);
  if (activeId === d.id && d.deletedAt) closeActive();
  const title = $<HTMLInputElement>('#document-title');
  if (existing && titleId === d.id && document.activeElement !== title && title.value !== next.title) title.value = next.title;
  if (!existing || metaKeys.some(key => existing[key] !== next[key])) await persist(next);
  if (existing?.title !== next.title) index(next.id, next.title);
  // An editor connected to the server already receives new content over its socket.
  if (!d.deletedAt && (!next.cached || !existing || d.revision !== existing.revision) && !opened.get(d.id)?.provider?.isSynced) await fetchState(d.id);
}
async function recoverDeleted(record: CachedDoc) {
  if (opened.has(record.id)) await saveLocal(record.id);
  const id = crypto.randomUUID(); const recovered = { ...record, id, title: `${record.title} (recovered offline edits)`, deletedAt: null, localOnly: true, dirty: true, createdAt: Date.now(), updatedAt: Date.now() };
  const saved = record.cached ? await stored(record.id) : undefined; if (saved) await store(id, saved);
  records.set(id, recovered); await persist(recovered); await enqueue('/documents', 'POST', { id, title: recovered.title }); record.dirty = false;
  toast('A document was deleted elsewhere. Your pending edits were preserved in a recovered note.');
}
function closeActive() { dropEditor(activeId); activeId = ''; titleId = ''; $('#document').hidden = true; $('#empty').hidden = false; closeMenu(false); status(); }
async function setDeleted(id: string, deleted: boolean) {
  const record = records.get(id)!; await saveLocal(id); record.deletedAt = deleted ? Date.now() : null;
  if (deleted) { const entry = opened.get(id); if (entry) disconnect(entry); if (id !== activeId) dropEditor(id); }
  await persist(record); if (activeId === id && deleted) closeActive(); renderList(); await enqueue(`/documents/${id}`, 'PATCH', { deleted, opId: crypto.randomUUID() });
}
// Open documents export from the worker's copy of the live document, which includes edits that local storage failed to save.
async function markdownOf(id: string) {
  const entry = opened.get(id);
  if (entry) { await entry.ready; return ask<string>({ type: 'markdown', id }); }
  return records.get(id)?.cached ? (await stored(id))?.markdown ?? '' : undefined;
}
async function exportOne() { if (!activeId) return; const record = records.get(activeId)!; download(filename(record.title, record.id), await markdownOf(activeId) || ''); }
export async function exportAll() {
  await flushLocal().catch(() => {}); const { zipSync, strToU8 } = await import('fflate'); const files: Record<string, Uint8Array> = {};
  for (const d of records.values()) if (!d.deletedAt) {
    if (!d.cached && !opened.has(d.id) && online) await fetchState(d.id);
    const text = await markdownOf(d.id); if (text === undefined) throw new Error('Some documents are not cached. Reconnect to export the entire library.');
    files[filename(d.title, d.id)] = strToU8(text);
  }
  download(`garnet-library-${new Date().toISOString().slice(0, 10)}.zip`, zipSync(files) as BlobPart, 'application/zip');
}
export async function importFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    if (file.size > 2 * 1024 * 1024) { toast(`${file.name} exceeds the 2 MB document limit.`); continue; }
    try { await newDocument(file.name.replace(/\.md$/i, ''), await file.text()); } catch (error: any) { toast(`Could not import ${file.name}: ${error.message}`); }
  }
}
function closeMenu(focus = true) {
  const navigation = $<HTMLDialogElement>('#navigation');
  if (!navigation.open) return;
  navigation.close();
  $('#menu-button').setAttribute('aria-expanded', 'false');
  if (focus) $('#menu-button').focus({ preventScroll: true });
}
function documentOptions() {
  const id = activeId; const record = records.get(id);
  const d = $('#document-menu');
  const disabled = record ? '' : 'disabled';
  d.innerHTML = `<button id="new-doc" aria-keyshortcuts="Alt+N">New document <kbd>Alt N</kbd></button><button id="export-button" ${disabled}>Export</button><button id="history" ${disabled}>Version history</button><button id="settings-button">Settings</button><hr><button id="delete" class="danger" ${disabled}>Move to trash</button>`;
  const action = (selector: string, run: () => void | Promise<void>) => {
    d.querySelector(selector)!.addEventListener('click', () => { closeMenu(); Promise.resolve().then(run).catch(error => toast(error.message)); });
  };
  action('#new-doc', async () => { await newDocument(); });
  action('#export-button', exportOne);
  action('#history', () => showHistory(id));
  action('#settings-button', () => import('./settings').then(m => m.showSettings({ user, prefs, markPreference, exportAll, importFiles, account: showAccount })));
  action('#delete', () => setDeleted(id, true));
  const navigation = $<HTMLDialogElement>('#navigation');
  if (listStale) drawList();
  if (!navigation.open) navigation.showModal();
  $('#menu-button').setAttribute('aria-expanded', 'true');
}
function revisionDiff(before: string, after: string) {
  const parts = diffLines(before, after);
  const lines = (part: typeof parts[number]) => part.lines.map(line => `<span class="diff-line diff-${part.kind}"><span class="diff-sign" aria-label="${part.kind === 'added' ? 'Added' : part.kind === 'removed' ? 'Removed' : 'Unchanged'}">${part.kind === 'added' ? '+' : part.kind === 'removed' ? '−' : ' '}</span><span>${escape(line) || '\u00a0'}</span></span>`).join('');
  return parts.map((part, index) => {
    if (part.kind === 'removed' && parts[index + 1]?.kind === 'added') return `<span class="diff-change" aria-label="Changed passage">${lines(part)}${lines(parts[index + 1])}</span>`;
    if (part.kind === 'added' && parts[index - 1]?.kind === 'removed') return '';
    return lines(part);
  }).join('');
}
async function showHistory(id: string) {
  try {
    await flushActive();
    const revisions = await api<SavedRevision[]>(`/documents/${id}/revisions`);
    const d = dialog('Version history', `<p class="muted">Each version shows what changed from the previous save. Restoring adds a new version only if the content differs.</p><div class="history-list">${revisions.length ? revisions.map((r: any) => `<button data-revision="${r._id}"><span>${escape(new Date(r.createdAt).toLocaleString())}</span><small>${escape(r.reason)}</small></button>`).join('') : '<p>No saved changes yet.</p>'}</div>`);
    d.querySelectorAll<HTMLButtonElement>('[data-revision]').forEach(button => button.onclick = () => {
      const revision = revisions.find(r => r._id === button.dataset.revision)!;
      const preview = dialog('Saved version', `<p class="muted">${escape(new Date(revision.createdAt).toLocaleString())} · Compared with the previous save</p><div class="diff-legend"><span class="diff-added">+ Added</span><span class="diff-removed">− Removed</span><span class="diff-change">Changed passage</span></div><div class="revision-preview" aria-label="Changes in this version">${revisionDiff(revision.previousMarkdown, revision.markdown)}</div><button class="primary" id="apply-revision">Restore this version</button>`);
      preview.classList.add('revision-dialog');
      preview.querySelector('#apply-revision')!.addEventListener('click', async () => { try { await flushActive(); const current = await api(`/documents/${id}/content`); await api(`/documents/${id}/restore`, 'POST', { revisionId: revision._id, version: current.version }); preview.close(); d.close(); } catch (error: any) { toast(error.message); } });
    });
  } catch (error: any) { toast(error.message); }
}
async function flushActive() {
  await flushLocal(); if (!online) throw new Error('Reconnect before starting an agent or restoring a version.');
  await synchronize();
  for (const [id, entry] of opened) { connect(id, entry); entry.provider?.sendStateless('flush'); }
  const until = Date.now() + 15000;
  while ([...records.values()].some(record => !record.deletedAt && (record.dirty || record.localOnly))) {
    if (Date.now() > until) throw new Error('Document is still syncing. Your edits are safe locally; try again once connected.');
    await new Promise(r => setTimeout(r, 100));
  }
}
async function toggleAI() {
  closeMenu(false);
  const panel = $('#ai-panel'); if (!panel.hidden) { panel.hidden = true; $('.workspace').classList.remove('ai-open'); return; }
  panel.hidden = false; $('.workspace').classList.add('ai-open');
  const { showAI } = await import('./ai'); showAI({ panel, records, active: () => activeId, flush: flushActive, close: () => { panel.hidden = true; $('.workspace').classList.remove('ai-open'); } });
}
function reauthenticate() {
  const d = dialog('Sign in to sync', `<p>Your local changes are retained.</p><form><label>Username<input name="username" value="${escape(user.username)}" readonly autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><button class="primary">Sign in</button></form>`);
  d.querySelector('form')!.onsubmit = async e => { e.preventDefault(); try { const result = await api('/login', 'POST', Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement)));
    // A reinstalled server's account needs a new password first (or is a different account): start again as it.
    if (result.user.id !== user.id || result.user.mustChangePassword) { localStorage.setItem('ed-user', JSON.stringify(result.user)); location.reload(); return; }
    setCsrf(result.csrf); d.close(); events?.close(); events = undefined; for (const entry of opened.values()) disconnect(entry); await synchronize(); if (activeId) await openDocument(activeId, false); } catch (error: any) { toast(error.message); } };
}
function showAccount() {
  const d = dialog('Your account', `<p>${escape(user.username)}${user.admin ? ' · Admin' : ''}</p><form id="change-password"><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" required></label><button>Change password</button></form><hr><button id="sign-out">Sign out and clear this device’s cache</button>`);
  d.querySelector('form')!.onsubmit = async e => { e.preventDefault(); try { await api('/password', 'POST', Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement))); toast('Password changed.'); d.close(); } catch (error: any) { toast(error.message); } };
  d.querySelector('#sign-out')!.addEventListener('click', async () => {
    await flushLocal();
    if ([...records.values()].some(r => r.dirty || r.localOnly) || (await cache.all('ops')).length) {
      const prompt = dialog('Keep your pending changes', '<p>This device has changes that have not reached the server. Sync first, or download a copy before signing out.</p><button id="export-signout">Download library and sign out</button>');
      prompt.querySelector('#export-signout')!.addEventListener('click', async () => { await exportAll(); await signOut(); }); return;
    }
    await signOut();
  });
}
async function signOut() {
  try { await api('/logout', 'POST', {}); } catch { if (navigator.onLine) { toast('Could not end the server session. Try signing out again.'); return; } }
  events?.close(); for (const live of editors.values()) live.editor.destroy(); for (const entry of opened.values()) { entry.provider?.destroy(); await entry.persistence.destroy(); entry.doc.destroy(); }
  await cache.clearAccount(user.id); localStorage.removeItem('ed-user'); location.href = '/';
}
