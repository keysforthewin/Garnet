import { api, escape, toast } from './api';
import type { AgentProvider, ModelCatalog, Settings } from '../shared/types';
let conversationId = ''; let cleanup: (() => void) | undefined;
export function showAI(context: { panel: HTMLElement; records: Map<string, any>; active: () => string; flush: () => Promise<void>; close: () => void }) {
  cleanup?.();
  const panel = context.panel;
  panel.innerHTML = `<div class="ai-heading"><h2>Ask your agent</h2><button class="icon-button" id="close-ai" aria-label="Close AI panel">×</button></div><div class="ai-controls"><select id="ai-provider" aria-label="Agent"><option value="claude">Claude</option><option value="codex">Codex</option></select></div><label class="compact-label">Model<select id="ai-model"><option value="">Use configured default</option></select><small id="ai-model-status" role="status" hidden></small></label><label class="compact-label">Conversation<select id="conversation"><option value="">New conversation</option></select></label><label class="compact-label">Starting context<select id="ai-scope"></select></label><div id="ai-transcript" aria-live="polite"><p class="ai-empty">Rework a paragraph.<br>Find a note you half remember.<br>Turn an idea into a first draft.</p></div><div id="ai-status" role="status"></div><form id="ai-form"><label class="sr-only" for="ai-prompt">Message your agent</label><textarea id="ai-prompt" rows="3" placeholder="What would you like to do?"></textarea><div class="ai-compose-actions"><small>Full host access</small><button type="button" id="cancel-job" hidden>Stop</button><button class="primary" id="send-prompt">Send</button></div></form>`;
  panel.querySelector('#close-ai')!.addEventListener('click', context.close);
  const transcript = panel.querySelector<HTMLElement>('#ai-transcript')!;
  const selector = panel.querySelector<HTMLSelectElement>('#conversation')!;
  const provider = panel.querySelector<HTMLSelectElement>('#ai-provider')!;
  const model = panel.querySelector<HTMLSelectElement>('#ai-model')!;
  const modelStatus = panel.querySelector<HTMLElement>('#ai-model-status')!;
  const scope = panel.querySelector<HTMLSelectElement>('#ai-scope')!;
  const status = panel.querySelector<HTMLElement>('#ai-status')!;
  const prompt = panel.querySelector<HTMLTextAreaElement>('#ai-prompt')!;
  let settings: Settings | undefined; let activeJob = ''; let disposed = false;
  let modelGeneration = 0; let historyGeneration = 0; let submitting = false; let busy = false;
  let loadingHistory = false; let agentGeneration = 0;
  prompt.value = sessionStorage.getItem('ed-agent-draft') || ''; prompt.oninput = () => sessionStorage.setItem('ed-agent-draft', prompt.value);
  function refreshContext() {
    const selected = scope.value;
    const options = `<option value="current">Current document</option><option value="library">Whole library</option>${[...context.records.values()].filter(d => !d.deletedAt && !d.purgedAt && d.id !== context.active()).map(d => `<option value="${escape(d.id)}">${escape(d.title)}</option>`).join('')}`;
    if (scope.innerHTML !== options) { scope.innerHTML = options; scope.value = [...scope.options].some(option => option.value === selected) ? selected : 'current'; }
  }
  function entry(kind: string, text: string) { transcript.querySelector('.ai-empty')?.remove(); const el = document.createElement('div'); el.className = `chat-entry ${kind}`; el.textContent = text; transcript.append(el); transcript.scrollTop = transcript.scrollHeight; return el; }
  function running(value: boolean) {
    busy = value;
    panel.querySelector<HTMLButtonElement>('#send-prompt')!.disabled = value || submitting;
    panel.querySelector<HTMLElement>('#cancel-job')!.hidden = !activeJob;
    provider.disabled = value || submitting || !!conversationId; model.disabled = value || submitting;
    selector.disabled = submitting; scope.disabled = submitting;
  }
  async function loadModels(selected = '') {
    const generation = ++modelGeneration;
    const agent = provider.value as AgentProvider;
    const defaultModel = settings?.agent[`${agent}Model`];
    const baseOptions = `<option value="">Default · ${escape(defaultModel || 'CLI default')}</option>`;
    model.innerHTML = baseOptions + (selected ? `<option value="${escape(selected)}">${escape(selected)}</option>` : ''); model.value = selected;
    modelStatus.hidden = false; modelStatus.textContent = 'Loading models…';
    if (!settings) { modelStatus.textContent = 'Reconnect to load available models.'; return; }
    try {
      const catalog = await api<ModelCatalog>('/agent-models', 'POST', { provider: agent, executable: settings.agent[`${agent}Path`], cwd: settings.agent.cwd });
      if (disposed || generation !== modelGeneration) return;
      const choice = model.value;
      model.innerHTML = baseOptions + catalog.models.map(m => `<option value="${escape(m.id)}">${escape(m.name)}${m.name !== m.id ? ` · ${escape(m.id)}` : ''}</option>`).join('') + (choice && !catalog.models.some(m => m.id === choice) ? `<option value="${escape(choice)}">${escape(choice)}</option>` : '');
      model.value = choice;
      modelStatus.textContent = catalog.error || (catalog.models.length ? '' : 'No models returned. The configured default is available.'); modelStatus.hidden = !modelStatus.textContent;
    } catch (error: any) { if (!disposed && generation === modelGeneration) { modelStatus.hidden = false; modelStatus.textContent = error.message; } }
  }
  provider.onchange = () => { void loadModels(); };
  async function loadConversations() {
    const list = await api('/conversations'); if (disposed) return;
    selector.innerHTML = '<option value="">New conversation</option>' + list.map((c: any) => `<option value="${escape(c._id)}">${escape(c.title)}</option>`).join('');
    if (!list.some((c: any) => c._id === conversationId)) conversationId = '';
    selector.value = conversationId;
  }
  async function loadHistory() {
    const generation = ++historyGeneration;
    loadingHistory = false; transcript.replaceChildren(); activeJob = ''; status.textContent = '';
    if (!conversationId) { running(false); void loadModels(); prompt.focus(); return; }
    running(true); loadingHistory = true;
    try {
      // Events may arrive after the server takes its history snapshot. Refetch
      // that snapshot before rendering so replies and completion stay in sync.
      let jobs: any[]; let snapshotGeneration: number;
      do {
        snapshotGeneration = agentGeneration;
        jobs = await api(`/conversations/${conversationId}/jobs`);
        if (disposed || generation !== historyGeneration) return;
      } while (snapshotGeneration !== agentGeneration);
      loadingHistory = false; transcript.replaceChildren();
      for (const job of jobs) {
        provider.value = job.provider; entry('user-message', job.prompt);
        const text = job.output || job.events.filter((e: any) => e.type === 'text').map((e: any) => e.text).join(''); if (text) entry('agent-message', text);
        if (job.error) entry('error', job.error);
        if (['queued', 'running'].includes(job.status)) activeJob = job._id;
      }
      void loadModels(jobs.at(-1)?.modelOverride || '');
      running(!!activeJob); status.textContent = activeJob ? 'Running…' : jobs.at(-1)?.status || '';
    } catch (error: any) { if (!disposed && generation === historyGeneration) { loadingHistory = false; running(false); status.textContent = error.message; } }
  }
  selector.onchange = () => { conversationId = selector.value; void loadHistory(); };
  panel.querySelector('#cancel-job')!.addEventListener('click', async () => { if (activeJob) { try { await api(`/jobs/${activeJob}/cancel`, 'POST', {}); status.textContent = 'Stopping…'; } catch (error: any) { toast(error.message); } } });
  panel.querySelector<HTMLFormElement>('#ai-form')!.onsubmit = async e => {
    e.preventDefault(); const text = prompt.value.trim(); if (!text || busy) return;
    if (!navigator.onLine) { toast('Reconnect to send. Your prompt is saved as a draft.'); return; }
    const request = { prompt: text, conversationId: conversationId || undefined, provider: provider.value, model: model.value, docId: scope.value === 'current' ? context.active() : scope.value === 'library' ? null : scope.value };
    submitting = true; running(true); status.textContent = 'Syncing document…';
    try {
      await context.flush(); const job = await api('/jobs', 'POST', request);
      if (disposed) return;
      conversationId = job.conversationId; activeJob = job.id; entry('user-message', text); prompt.value = ''; sessionStorage.removeItem('ed-agent-draft'); status.textContent = 'Running…'; await loadConversations(); await loadHistory();
    } catch (error: any) { if (!disposed) { running(!!activeJob); status.textContent = error.message; } }
    finally { submitting = false; if (!disposed) running(!!activeJob); }
  };
  const listener = (event: Event) => {
    const data = (event as CustomEvent).detail; if (data.conversationId !== conversationId) return;
    agentGeneration++; if (loadingHistory) return;
    if (data.type === 'text') { let last = transcript.lastElementChild as HTMLElement; if (!last?.classList.contains('agent-message')) last = entry('agent-message', ''); last.textContent += data.text; transcript.scrollTop = transcript.scrollHeight; }
    if (data.type === 'activity' || data.type === 'status') status.textContent = data.text;
    if (data.type === 'done') { activeJob = ''; running(false); status.textContent = data.status; if (data.error) entry('error', data.error); }
  };
  window.addEventListener('ed-agent', listener); window.addEventListener('ed-documents', refreshContext);
  cleanup = () => { disposed = true; window.removeEventListener('ed-agent', listener); window.removeEventListener('ed-documents', refreshContext); };
  refreshContext(); running(true);
  void (async () => {
    try { settings = await api<Settings>('/settings'); if (disposed) return; provider.value = settings.agent.provider; }
    catch { /* Existing conversations and drafts remain available offline. */ }
    if (disposed) return;
    try { await loadConversations(); if (!disposed) await loadHistory(); }
    catch { if (!disposed) { running(false); void loadModels(); status.textContent = 'Offline · your prompt stays a draft'; } }
  })();
  prompt.focus();
}
