import { api, escape, toast } from './api';
let conversationId = ''; let activeJob = ''; let listener: ((event: Event) => void) | undefined;
export function showAI(context: { panel: HTMLElement; records: Map<string, any>; active: () => string; flush: () => Promise<void>; close: () => void }) {
  const panel = context.panel;
  panel.innerHTML = `<div class="ai-heading"><h2>Ask your agent</h2><button class="icon-button" id="close-ai" aria-label="Close AI panel">×</button></div><div class="ai-controls"><select id="ai-provider" aria-label="Agent"><option value="claude">Claude</option><option value="codex">Codex</option></select><button id="new-chat">New chat</button></div><label class="compact-label">Conversation<select id="conversation"><option value="">New conversation</option></select></label><label class="compact-label">Starting context<select id="ai-scope"><option value="current">Current document</option><option value="library">Whole library</option>${[...context.records.values()].filter(d => !d.deletedAt).map(d => `<option value="${d.id}">${escape(d.title)}</option>`).join('')}</select></label><div id="ai-transcript" aria-live="polite"><p class="ai-empty">Rework a paragraph.<br>Find a note you half remember.<br>Turn an idea into a first draft.</p></div><div id="ai-status" role="status"></div><form id="ai-form"><label class="sr-only" for="ai-prompt">Message your agent</label><textarea id="ai-prompt" rows="3" placeholder="What would you like to do?"></textarea><div class="ai-compose-actions"><small>Full host access</small><button type="button" id="cancel-job" hidden>Stop</button><button class="primary" id="send-prompt">Send</button></div></form>`;
  panel.querySelector('#close-ai')!.addEventListener('click', context.close);
  const transcript = panel.querySelector<HTMLElement>('#ai-transcript')!;
  const selector = panel.querySelector<HTMLSelectElement>('#conversation')!;
  const provider = panel.querySelector<HTMLSelectElement>('#ai-provider')!;
  const prompt = panel.querySelector<HTMLTextAreaElement>('#ai-prompt')!;
  prompt.value = sessionStorage.getItem('ed-agent-draft') || ''; prompt.oninput = () => sessionStorage.setItem('ed-agent-draft', prompt.value);
  function entry(kind: string, text: string) { transcript.querySelector('.ai-empty')?.remove(); const el = document.createElement('div'); el.className = `chat-entry ${kind}`; el.textContent = text; transcript.append(el); transcript.scrollTop = transcript.scrollHeight; return el; }
  function running(value: boolean) { panel.querySelector<HTMLButtonElement>('#send-prompt')!.disabled = value; panel.querySelector<HTMLElement>('#cancel-job')!.hidden = !value; provider.disabled = !!conversationId; }
  async function loadConversations() {
    try { const list = await api('/conversations'); selector.innerHTML = '<option value="">New conversation</option>' + list.map((c: any) => `<option value="${c._id}">${escape(c.title)}</option>`).join(''); selector.value = conversationId; } catch { panel.querySelector('#ai-status')!.textContent = 'Offline · your prompt stays a draft'; }
  }
  async function loadHistory() {
    transcript.replaceChildren(); activeJob = ''; if (!conversationId) { running(false); return; }
    const jobs = await api(`/conversations/${conversationId}/jobs`);
    for (const job of jobs) {
      provider.value = job.provider; entry('user-message', job.prompt);
      const text = job.output || job.events.filter((e: any) => e.type === 'text').map((e: any) => e.text).join(''); if (text) entry('agent-message', text);
      if (job.error) entry('error', job.error);
      if (['queued', 'running'].includes(job.status)) activeJob = job._id;
    }
    running(!!activeJob); panel.querySelector('#ai-status')!.textContent = activeJob ? 'Running…' : '';
  }
  selector.onchange = () => { conversationId = selector.value; void loadHistory().catch(error => toast(error.message)); };
  panel.querySelector('#new-chat')!.addEventListener('click', () => { conversationId = ''; activeJob = ''; selector.value = ''; transcript.replaceChildren(); running(false); prompt.focus(); });
  panel.querySelector('#cancel-job')!.addEventListener('click', async () => { if (activeJob) { try { await api(`/jobs/${activeJob}/cancel`, 'POST', {}); panel.querySelector('#ai-status')!.textContent = 'Stopping…'; } catch (error: any) { toast(error.message); } } });
  panel.querySelector<HTMLFormElement>('#ai-form')!.onsubmit = async e => {
    e.preventDefault(); const text = prompt.value.trim(); if (!text) return;
    if (!navigator.onLine) { toast('Reconnect to send. Your prompt is saved as a draft.'); return; }
    running(true); panel.querySelector('#ai-status')!.textContent = 'Syncing document…';
    try {
      await context.flush(); const scope = panel.querySelector<HTMLSelectElement>('#ai-scope')!.value;
      const job = await api('/jobs', 'POST', { prompt: text, conversationId: conversationId || undefined, provider: provider.value, docId: scope === 'current' ? context.active() : scope === 'library' ? null : scope });
      conversationId = job.conversationId; activeJob = job.id; entry('user-message', text); prompt.value = ''; sessionStorage.removeItem('ed-agent-draft'); panel.querySelector('#ai-status')!.textContent = 'Running…'; await loadConversations(); await loadHistory();
    } catch (error: any) { running(false); panel.querySelector('#ai-status')!.textContent = error.message; }
  };
  if (listener) window.removeEventListener('ed-agent', listener);
  listener = (event: Event) => {
    const data = (event as CustomEvent).detail; if (data.conversationId !== conversationId) return;
    if (data.type === 'text') { let last = transcript.lastElementChild as HTMLElement; if (!last?.classList.contains('agent-message')) last = entry('agent-message', ''); last.textContent += data.text; transcript.scrollTop = transcript.scrollHeight; }
    if (data.type === 'activity' || data.type === 'status') panel.querySelector('#ai-status')!.textContent = data.text;
    if (data.type === 'done') { running(false); activeJob = ''; panel.querySelector('#ai-status')!.textContent = data.status; if (data.error) entry('error', data.error); }
  };
  window.addEventListener('ed-agent', listener); void loadConversations().then(loadHistory).catch(error => toast(error.message)); prompt.focus();
}
