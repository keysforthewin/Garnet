import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey, yDocToProsemirrorJSON, updateYFragment, initProseMirrorDoc } from '@tiptap/y-tiptap';
import { extensions, schema, parseMarkdown, serializeMarkdown, filename } from '../shared/editor';
import type { User, DocMeta } from '../shared/types';
import { persistenceSignature } from '../shared/sync';
import { diffLines, type SavedRevision } from '../shared/history';
import { api, csrf, setCsrf, toast, escape, dialog, download } from './api';
import * as cache from './db';

interface CachedDoc extends DocMeta { state?: string; markdown?: string; dirty?: boolean; localOnly?: boolean }
interface OpenDoc { doc: Y.Doc; persistence: IndexeddbPersistence; provider?: HocuspocusProvider; touched: number; timer?: ReturnType<typeof setTimeout>; localWrite?: Promise<void>; generation: number }
interface Operation { id: string; version: string; path: string; method: string; body: any; createdAt: number }
const records = new Map<string, CachedDoc>();
const opened = new Map<string, OpenDoc>();
let user: User; let editor: Editor | undefined; let activeId = ''; let currentOpen = 0;
let prefs: Record<string, any> = {}; let preferenceTimer: ReturnType<typeof setTimeout>; let changedPrefs: Record<string, any> = {};
let syncRunning = false; let syncAgain = false; let online = navigator.onLine; let events: EventSource | undefined; let searchQuery = ''; let matches: Set<string> | null = null;
let localError = false; let showingTrash = false;
const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
const b64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
const unb64 = (text: string) => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
function localFailure(error: any) { localError = true; status('local-error'); toast(`Local storage: ${error.message}. Export your notes before closing this page.`); }
async function persist(record: CachedDoc) { try { await cache.put('docs', record.id, { ...record }); } catch (error) { localFailure(error); throw error; } }
function markPreference(key: string, value: any) {
  prefs[key] = value; changedPrefs[key] = value;
  cache.put('prefs', 'values', prefs).catch(localFailure);
  clearTimeout(preferenceTimer); preferenceTimer = setTimeout(() => {
    const body = changedPrefs; changedPrefs = {};
    void enqueue('/preferences', 'PATCH', body);
  }, 750);
}
export async function start(account: User) {
  user = account; await cache.openCache(user.id);
  for (const record of await cache.all<CachedDoc>('docs')) records.set(record.id, record);
  prefs = await cache.get('prefs', 'values') || {};
  document.documentElement.dataset.theme = prefs.theme || 'system';
  $('#app').innerHTML = `<div class="workspace ${prefs.sidebarCollapsed ? 'sidebar-collapsed' : ''}"><aside id="sidebar"><div class="sidebar-top"><a href="#" class="wordmark" aria-label="Garnet home">Garnet</a><button id="collapse" class="icon-button" title="Collapse sidebar (Ctrl+\\)" aria-label="Collapse sidebar">«</button></div><label class="search-label"><span class="sr-only">Search documents</span><input id="search" type="search" placeholder="Search your notes…" autocomplete="off"><kbd>⌘ K</kbd></label><div class="list-heading"><span id="list-label">YOUR DOCUMENTS</span><span id="doc-count"></span></div><nav id="doc-list" aria-label="Documents"></nav><div class="sidebar-bottom"><button id="trash-button">Trash</button><button id="settings-button">Settings</button><button id="account-button" title="Account">${escape(user.username)}</button></div><div id="sync-error" class="sync-error" hidden></div></aside><main id="main"><header class="document-header"><div class="document-menu"><button id="menu-button" class="icon-button" aria-label="Open menu" aria-expanded="false" aria-controls="document-menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><div id="document-menu" class="menu-dropdown" hidden></div></div><div class="header-actions"><button id="ai-button" class="ai-button">Ask AI <kbd>⌘ J</kbd></button></div></header><div id="empty"><div class="empty-mark">Garnet</div><h1>Room to think.</h1><p>A quick note, a rough idea, a shared draft.<br>Choose a document or start a fresh page.</p><button class="primary" id="empty-new">New document</button></div><section id="document" hidden><input id="document-title" aria-label="Document title" placeholder="Untitled" maxlength="200"><div id="toolbar" role="toolbar" aria-label="Formatting"><button data-command="bold" title="Bold (Ctrl+B)"><strong>B</strong></button><button data-command="italic" title="Italic (Ctrl+I)"><em>I</em></button><button data-command="strike" title="Strikethrough"><s>S</s></button><span class="toolbar-divider"></span><button data-command="heading" title="Heading">H2</button><button data-command="bulletList" title="Bullet list">List</button><button data-command="orderedList" title="Numbered list">1.</button><button data-command="taskList" title="Checklist">Tasks</button><button data-command="blockquote" title="Quote">Quote</button><button data-command="codeBlock" title="Code block">Code</button><button data-command="link" title="Insert link">Link</button><button data-command="table" title="Insert table">Table</button><span class="toolbar-divider"></span><button data-command="undo" title="Undo">↶</button><button data-command="redo" title="Redo">↷</button></div><div id="editor-mount"></div><footer class="document-footer"><span id="word-count"></span><span id="people"></span></footer></section></main><aside id="ai-panel" hidden></aside></div>`;
  $('#empty-new').onclick = () => void newDocument();
  $('#collapse').onclick = () => toggleSidebar(true);
  $('#search').oninput = () => { searchQuery = ($<HTMLInputElement>('#search')).value; worker.postMessage({ type: 'search', query: searchQuery }); };
  worker.onmessage = ({ data }) => { if (data.query === searchQuery) { matches = searchQuery.trim() ? new Set(data.ids) : null; renderList(); } };
  $('#trash-button').onclick = () => { showingTrash = !showingTrash; $('#trash-button').classList.toggle('selected', showingTrash); renderList(); };
  $('#settings-button').onclick = () => void import('./settings').then(m => m.showSettings({ user, prefs, markPreference, exportAll, importFiles, account: showAccount }));
  $('#account-button').onclick = showAccount;
  $('#menu-button').onclick = () => { if ($('#document-menu').hidden) documentOptions(); else closeMenu(); };
  document.addEventListener('pointerdown', e => { if (!(e.target as Element).closest('.document-menu')) closeMenu(false); });
  $('.document-menu').addEventListener('focusout', e => { if (!(e.currentTarget as HTMLElement).contains((e as FocusEvent).relatedTarget as Node | null)) closeMenu(false); });
  $('.document-menu').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      if ($('#document-menu').hidden) documentOptions();
      const buttons = [...$('#document-menu').querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : current < 0 ? 0 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }
  });
  $('#ai-button').onclick = () => void toggleAI();
  $('#document-title').oninput = () => {
    const id = activeId; const record = records.get(id)!; record.title = $<HTMLInputElement>('#document-title').value || 'Untitled';
    persist(record).catch(() => {}); renderList();
    void enqueue(`/documents/${id}`, 'PATCH', { title: record.title, opId: crypto.randomUUID() });
  };
  $('#toolbar').addEventListener('mousedown', e => { if ((e.target as Element).closest('button')) e.preventDefault(); });
  $('#toolbar').addEventListener('click', e => { const button = (e.target as Element).closest<HTMLButtonElement>('button[data-command]'); if (button && editor) command(button.dataset.command!); });
  $('#main').addEventListener('scroll', () => saveCursor(), { passive: true });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); toggleSidebar(false); $<HTMLInputElement>('#search').focus(); }
    if ((e.altKey && e.key.toLowerCase() === 'n') || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n')) { e.preventDefault(); void newDocument(); }
    if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); toggleSidebar(!$('.workspace').classList.contains('sidebar-collapsed')); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); void toggleAI(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); flushActive().catch(e => toast(e.message)); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { saveCursor(); void flushLocal(); opened.get(activeId)?.provider?.sendStateless('flush'); } });
  window.addEventListener('beforeunload', e => { if (localError) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('offline', () => { online = false; status(); });
  window.addEventListener('online', () => { void synchronize(); });
  renderList(); worker.postMessage({ type: 'index', docs: [...records.values()] });
  const hashId = location.hash.slice(1); const initial = hashId || prefs.lastDocument;
  if (initial && records.has(initial) && !records.get(initial)!.deletedAt) await openDocument(initial, false);
  await synchronize();
  if (!activeId && initial && records.has(initial) && !records.get(initial)!.deletedAt) await openDocument(initial, false);
  setInterval(() => void synchronize(), 20000);
}
function toggleSidebar(collapsed: boolean) { $('.workspace').classList.toggle('sidebar-collapsed', collapsed); markPreference('sidebarCollapsed', collapsed); }
function status(message?: 'local-error' | 'saving' | 'auth-required') {
  if (!activeId) { $('#main').dataset.saveState = online ? 'idle' : 'offline'; return; }
  const d = records.get(activeId)!;
  $('#main').dataset.saveState = message || (localError ? 'local-error' : !online ? 'offline' : d.dirty || d.localOnly ? 'syncing' : 'saved');
}
function renderList() {
  const pins = prefs.pins || [];
  const docs = [...records.values()].filter(d => !d.purgedAt && Boolean(d.deletedAt) === showingTrash && (!matches || matches.has(d.id))).sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)) || b.updatedAt - a.updatedAt);
  $('#list-label').textContent = showingTrash ? 'TRASH' : searchQuery ? 'SEARCH RESULTS' : 'YOUR DOCUMENTS'; $('#doc-count').textContent = String(docs.length);
  $('#doc-list').innerHTML = docs.length ? docs.map(d => `<div class="doc-item ${d.id === activeId ? 'active' : ''}"><button class="doc-row ${d.id === activeId ? 'active' : ''}" data-id="${d.id}" ${d.id === activeId ? 'aria-current="page"' : ''}><span class="document-glyph" aria-hidden="true">≡</span><span class="doc-name">${escape(d.title)}</span>${d.dirty || d.localOnly ? '<span class="pending-dot" title="Pending sync"></span>' : ''}</button>${showingTrash ? '' : `<button class="pin-button" data-pin="${d.id}" aria-label="${pins.includes(d.id) ? 'Unpin' : 'Pin'} ${escape(d.title)}" aria-pressed="${pins.includes(d.id)}" title="${pins.includes(d.id) ? 'Unpin' : 'Pin to top'}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6v6l3 3v3H6v-3l3-3V3M12 15v6"/></svg></button>`}</div>`).join('') : `<p class="list-empty">${searchQuery ? 'No matching documents.' : showingTrash ? 'Trash is empty.' : 'Your first note starts here.'}</p>`;
  $('#doc-list').querySelectorAll<HTMLButtonElement>('[data-id]').forEach(button => button.onclick = () => {
    if (showingTrash) { const id = button.dataset.id!; const d = dialog('Restore document', `<p>${escape(records.get(id)!.title)}</p><button class="primary" id="restore-trash">Restore</button>`); d.querySelector('#restore-trash')!.addEventListener('click', () => { void setDeleted(id, false); d.close(); }); }
    else void openDocument(button.dataset.id!);
  });
  $('#doc-list').querySelectorAll<HTMLButtonElement>('[data-pin]').forEach(button => button.onclick = () => {
    const id = button.dataset.pin!;
    markPreference('pins', pins.includes(id) ? pins.filter((pin: string) => pin !== id) : [...pins, id]);
    renderList(); $('#doc-list').querySelector<HTMLButtonElement>(`[data-pin="${id}"]`)?.focus();
  });

}
async function enqueue(url: string, method: string, body: any) {
  const operation: Operation = { id: method === 'PATCH' && body.title !== undefined ? `rename-${url.split('/')[2]}` : crypto.randomUUID(), version: crypto.randomUUID(), path: url, method, body, createdAt: Date.now() };
  try { await cache.put('ops', operation.id, operation);  void synchronize(); } catch (error) { localFailure(error); }
}
async function newDocument(title = 'Untitled', initialMarkdown?: string) {
  const id = crypto.randomUUID(); const record: CachedDoc = { id, title, createdAt: Date.now(), updatedAt: Date.now(), revision: 0, mirrorRevision: -1, deletedAt: null, localOnly: true, dirty: true };
  if (initialMarkdown !== undefined) {
    const doc = new Y.Doc(); const fragment = doc.getXmlFragment('default');
    updateYFragment(doc, fragment, schema.nodeFromJSON(parseMarkdown(initialMarkdown)), { mapping: initProseMirrorDoc(fragment, schema).mapping, isOMark: new Map() });
    record.state = b64(Y.encodeStateAsUpdate(doc)); record.markdown = serializeMarkdown(yDocToProsemirrorJSON(doc, 'default')); doc.destroy();
  }
  records.set(id, record); renderList();
  const persistTask = persist(record); void openDocument(id).then(async () => {
    if (activeId !== id) return;
    if (title === 'Untitled') { const input = $<HTMLInputElement>('#document-title'); input.focus(); input.select(); } else editor?.commands.focus('end');
  });
  await persistTask; await enqueue('/documents', 'POST', { id, title }); return id;
}
async function getOpen(id: string): Promise<OpenDoc> {
  let existing = opened.get(id); if (existing) { existing.touched = Date.now(); return existing; }
  const record = records.get(id)!; const doc = new Y.Doc();
  if (record.state) Y.applyUpdate(doc, unb64(record.state));
  const persistence = new IndexeddbPersistence(`ed:${user.id}:doc:${id}`, doc);
  const entry: OpenDoc = { doc, persistence, touched: Date.now(), generation: 0 }; opened.set(id, entry);
  await persistence.whenSynced;
  doc.on('update', () => {
    entry.generation++; const current = records.get(id); if (!current) return;
    current.dirty = true;
    if (id === activeId) status('saving');
    clearTimeout(entry.timer); entry.timer = setTimeout(() => void saveLocal(id), 60);
  });
  connect(id, entry);
  return entry;
}
function connect(id: string, entry: OpenDoc) {
  const record = records.get(id); if (!online || !csrf || entry.provider || record?.localOnly || record?.deletedAt) return;
  const provider = new HocuspocusProvider({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collaboration`, name: id, document: entry.doc, token: () => csrf,
    onSynced: () => { provider.sendStateless('flush'); },
    onAuthenticationFailed: () => { if (id === activeId) status('auth-required'); },
    onStateless: async ({ payload }) => {
      const event = JSON.parse(payload);
      if (event.type !== 'persisted') return;
      const generation = entry.generation; const signature = persistenceSignature(Y.encodeStateAsUpdate(entry.doc));
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (hash === event.stateHash && generation === entry.generation) {
        const d = records.get(id)!; d.dirty = false; await saveLocal(id); if (id === activeId) status(); renderList();
      }
    },
    onAwarenessUpdate: () => { if (id === activeId) { const names = [...(provider.awareness?.getStates().values() || [])].map((s: any) => s.user?.name).filter(Boolean); $('#people').textContent = names.length > 1 ? `${names.length} people here` : ''; } },
  });
  entry.provider = provider;
}
async function saveLocal(id: string) {
  const entry = opened.get(id); const record = records.get(id); if (!entry || !record) return;
  clearTimeout(entry.timer); entry.timer = undefined;
  record.state = b64(Y.encodeStateAsUpdate(entry.doc)); record.markdown = serializeMarkdown(yDocToProsemirrorJSON(entry.doc, 'default'));
  entry.localWrite = persist(record); await entry.localWrite;
  worker.postMessage({ type: 'index', docs: [record] }); if (id === activeId) { status(); updateWordCount(); }
}
async function flushLocal() { await Promise.all([...opened.keys()].map(saveLocal)); }
async function openDocument(id: string, focus = true) {
  const count = ++currentOpen; saveCursor(); const previous = activeId;
  if (previous) void saveLocal(previous);
  const record = records.get(id); if (!record) return;
  if (!record.state && !record.localOnly) {
    if (!online) { toast('This document has not finished downloading for offline use.'); return; }
    try { await fetchState(id); } catch (error: any) { toast(error.message); return; }
  }
  const entry = await getOpen(id); if (count !== currentOpen) return;
  editor?.destroy(); editor = undefined; activeId = id; markPreference('lastDocument', id); history.replaceState(null, '', `#${id}`);
  $('#empty').hidden = true; $('#document').hidden = false; $<HTMLInputElement>('#document-title').value = record.title;
  closeMenu(false);
  $('#editor-mount').replaceChildren();
  editor = new Editor({ element: $('#editor-mount'), extensions: [...extensions(), Collaboration.configure({ document: entry.doc }), ...(entry.provider ? [CollaborationCaret.configure({ provider: entry.provider, user: { name: user.username, color: ['#557a59', '#617daf', '#ab6f47', '#9275a9'][user.username.charCodeAt(0) % 4] } })] : [])], editorProps: { attributes: { class: 'prose', spellcheck: 'true', 'aria-label': 'Document content', 'data-placeholder': 'Start writing…', role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: () => { updateWordCount(); }, onSelectionUpdate: () => { saveCursor(); updateToolbar(); },
  });
  restoreCursor(focus); updateWordCount(); renderList(); status();
  if (window.innerWidth < 760) toggleSidebar(true);
  while (opened.size > 8) {
    const candidate = [...opened].filter(([key, value]) => key !== activeId && !records.get(key)?.dirty).sort((a, b) => a[1].touched - b[1].touched)[0];
    if (!candidate) break; await saveLocal(candidate[0]); candidate[1].provider?.destroy(); await candidate[1].persistence.destroy(); candidate[1].doc.destroy(); opened.delete(candidate[0]);
  }
}
function saveCursor() {
  if (!editor || !activeId || editor.isDestroyed) return;
  const sync = ySyncPluginKey.getState(editor.state); if (!sync?.binding) return;
  try {
    const anchor = absolutePositionToRelativePosition(editor.state.selection.anchor, sync.type, sync.binding.mapping);
    const head = absolutePositionToRelativePosition(editor.state.selection.head, sync.type, sync.binding.mapping);
    markPreference(`cursor_${activeId}`, { anchor: Y.relativePositionToJSON(anchor), head: Y.relativePositionToJSON(head), scroll: $('#main').scrollTop });
  } catch { /* The initial editor transaction may not yet have a mapping. */ }
}
function restoreCursor(focus: boolean) {
  const saved = prefs[`cursor_${activeId}`]; const sync = ySyncPluginKey.getState(editor!.state);
  let anchor = 1; let head = 1;
  if (saved && sync?.binding) {
    anchor = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(saved.anchor), sync.binding.mapping) ?? 1;
    head = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(saved.head), sync.binding.mapping) ?? anchor;
  }
  const max = editor!.state.doc.content.size; editor!.commands.setTextSelection({ from: Math.min(anchor, max), to: Math.min(head, max) });
  if (focus) editor!.commands.focus(undefined, { scrollIntoView: false });
  requestAnimationFrame(() => { $('#main').scrollTop = saved?.scroll || 0; });
}
function updateWordCount() { if (editor && !editor.isDestroyed) { const text = editor.getText().trim(); $('#word-count').textContent = `${text ? text.split(/\s+/).length : 0} words`; } }
function updateToolbar() { if (!editor) return; $('#toolbar').querySelectorAll<HTMLButtonElement>('[data-command]').forEach(b => b.setAttribute('aria-pressed', String(editor!.isActive(b.dataset.command!)))); }
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
  const remote = await api(`/documents/${id}/state`); const record = records.get(id); if (!record) return;
  const entry = opened.get(id);
  if (entry) { Y.applyUpdate(entry.doc, unb64(remote.state), 'remote-fetch'); await saveLocal(id); }
  else if (record.dirty && record.state) {
    const doc = new Y.Doc(); Y.applyUpdate(doc, unb64(record.state)); Y.applyUpdate(doc, unb64(remote.state)); record.state = b64(Y.encodeStateAsUpdate(doc)); record.markdown = serializeMarkdown(yDocToProsemirrorJSON(doc, 'default')); doc.destroy(); await persist(record);
  } else { record.state = remote.state; record.markdown = remote.markdown; await persist(record); }
  worker.postMessage({ type: 'index', docs: [record] });
}
async function synchronize() {
  if (syncRunning) { syncAgain = true; return; }
  if (!navigator.onLine) { return; } syncRunning = true; syncAgain = false;
  try {
    const me = await api('/me'); if (me.user.id !== user.id) throw new Error('Account changed. Reload this page.'); setCsrf(me.csrf); online = true; $('#sync-error').hidden = true;
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
    const serverPrefs = await api('/preferences'); prefs = { ...serverPrefs, ...prefs }; await cache.put('prefs', 'values', prefs);
    const remote: DocMeta[] = await api('/documents');
    const queued = await cache.all<Operation>('ops'); const changed = new Set(queued.filter(o => o.path.startsWith('/documents/')).map(o => o.path.split('/')[2]));
    for (const d of remote) {
      const existing = records.get(d.id);
      if (d.deletedAt && existing?.dirty && !existing.deletedAt) await recoverDeleted(existing);
      const next = { ...existing, ...d, localOnly: false } as CachedDoc;
      if (changed.has(d.id) && existing) { next.title = existing.title; next.deletedAt = existing.deletedAt; }
      records.set(d.id, next);
      if (activeId === d.id && d.deletedAt) closeActive();
      if (existing && activeId === d.id && document.activeElement !== $('#document-title')) $<HTMLInputElement>('#document-title').value = next.title;
      await persist(next);
      if (!d.deletedAt && (!next.state || !existing || d.revision !== existing.revision)) await fetchState(d.id);
    }
    for (const [id, record] of records) {
      if (record.deletedAt || record.localOnly) continue;
      if (record.dirty) await getOpen(id);
      const entry = opened.get(id); if (entry) connect(id, entry);
    }
    if (!events) {
      events = new EventSource('/api/events');
      events.addEventListener('document', e => { const d = JSON.parse((e as MessageEvent).data); const current = records.get(d.id); if (!current || current.revision !== d.revision || current.deletedAt !== d.deletedAt) { setTimeout(() => void synchronize(), 100); } });
      events.addEventListener('mirror-error', e => { const d = JSON.parse((e as MessageEvent).data); toast(d.error); });
      events.addEventListener('agent', e => window.dispatchEvent(new CustomEvent('ed-agent', { detail: JSON.parse((e as MessageEvent).data) })));
      events.onerror = () => { online = false; status(); };
      events.onopen = () => { online = true; status(); };
    }
    renderList(); status();
  } catch (error: any) {
    online = false; if (error.status === 401) { status('auth-required'); $('#sync-error').hidden = false; $('#sync-error').innerHTML = '<button id="reauth">Sign in to sync your local changes</button>'; $('#reauth').onclick = reauthenticate; } else { status(); }
  } finally { syncRunning = false; if (online && (syncAgain || (await cache.all('ops')).length)) setTimeout(() => void synchronize(), 250); }
}
async function recoverDeleted(record: CachedDoc) {
  if (opened.has(record.id)) await saveLocal(record.id);
  const id = crypto.randomUUID(); const recovered = { ...record, id, title: `${record.title} (recovered offline edits)`, deletedAt: null, localOnly: true, dirty: true, createdAt: Date.now(), updatedAt: Date.now() };
  records.set(id, recovered); await persist(recovered); await enqueue('/documents', 'POST', { id, title: recovered.title }); record.dirty = false;
  toast('A document was deleted elsewhere. Your pending edits were preserved in a recovered note.');
}
function closeActive() { editor?.destroy(); editor = undefined; activeId = ''; $('#document').hidden = true; $('#empty').hidden = false; closeMenu(false); status(); }
async function setDeleted(id: string, deleted: boolean) {
  const record = records.get(id)!; await saveLocal(id); record.deletedAt = deleted ? Date.now() : null;
  if (deleted) { opened.get(id)?.provider?.destroy(); if (opened.has(id)) opened.get(id)!.provider = undefined; }
  await persist(record); if (activeId === id && deleted) closeActive(); renderList(); await enqueue(`/documents/${id}`, 'PATCH', { deleted, opId: crypto.randomUUID() });
}
async function exportOne() { if (!activeId) return; await saveLocal(activeId).catch(() => {}); const record = records.get(activeId)!; download(filename(record.title, record.id), record.markdown || ''); }
export async function exportAll() {
  await flushLocal().catch(() => {}); const { zipSync, strToU8 } = await import('fflate'); const files: Record<string, Uint8Array> = {};
  for (const d of records.values()) if (!d.deletedAt) { if (d.state === undefined && online) await fetchState(d.id); if (d.state === undefined) throw new Error('Some documents are not cached. Reconnect to export the entire library.'); files[filename(d.title, d.id)] = strToU8(d.markdown || ''); }
  download(`garnet-library-${new Date().toISOString().slice(0, 10)}.zip`, zipSync(files) as BlobPart, 'application/zip');
}
export async function importFiles(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    if (file.size > 2 * 1024 * 1024) { toast(`${file.name} exceeds the 2 MB document limit.`); continue; }
    const text = await file.text(); await newDocument(file.name.replace(/\.md$/i, ''), text);
  }
}
function closeMenu(focus = true) {
  if ($('#document-menu').hidden) return;
  $('#document-menu').hidden = true;
  $('#menu-button').setAttribute('aria-expanded', 'false');
  if (focus) $('#menu-button').focus();
}
function documentOptions() {
  const id = activeId; const record = records.get(id);
  const d = $('#document-menu');
  const disabled = record ? '' : 'disabled';
  d.innerHTML = `<button id="new-doc" aria-keyshortcuts="Alt+N">New document <kbd>Alt N</kbd></button><hr><button id="toggle-sidebar">${$('.workspace').classList.contains('sidebar-collapsed') ? 'Show' : 'Hide'} sidebar</button><hr><button id="export-button" ${disabled}>Export</button><button id="history" ${disabled}>Version history</button><hr><button id="delete" class="danger" ${disabled}>Move to trash</button>`;
  const action = (selector: string, run: () => void | Promise<void>) => {
    d.querySelector(selector)!.addEventListener('click', () => { closeMenu(); Promise.resolve().then(run).catch(error => toast(error.message)); });
  };
  action('#new-doc', async () => { await newDocument(); });
  action('#toggle-sidebar', () => toggleSidebar(!$('.workspace').classList.contains('sidebar-collapsed')));
  action('#export-button', exportOne);
  action('#history', () => showHistory(id));
  action('#delete', () => setDeleted(id, true));
  d.hidden = false;
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
  const panel = $('#ai-panel'); if (!panel.hidden) { panel.hidden = true; $('.workspace').classList.remove('ai-open'); return; }
  panel.hidden = false; $('.workspace').classList.add('ai-open');
  const { showAI } = await import('./ai'); showAI({ panel, records, active: () => activeId, flush: flushActive, close: () => { panel.hidden = true; $('.workspace').classList.remove('ai-open'); } });
}
function reauthenticate() {
  const d = dialog('Sign in to sync', `<p>Your local changes are retained.</p><form><label>Username<input name="username" value="${escape(user.username)}" readonly autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><button class="primary">Sign in</button></form>`);
  d.querySelector('form')!.onsubmit = async e => { e.preventDefault(); try { const result = await api('/login', 'POST', Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement))); setCsrf(result.csrf); d.close(); events?.close(); events = undefined; for (const entry of opened.values()) { entry.provider?.destroy(); entry.provider = undefined; } await synchronize(); if (activeId) await openDocument(activeId, false); } catch (error: any) { toast(error.message); } };
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
  events?.close(); editor?.destroy(); for (const entry of opened.values()) { entry.provider?.destroy(); await entry.persistence.destroy(); entry.doc.destroy(); }
  await cache.clearAccount(user.id); localStorage.removeItem('ed-user'); location.href = '/';
}
