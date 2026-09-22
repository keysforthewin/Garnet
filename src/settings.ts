import { api, dialog, escape, toast } from './api';
import type { User, Settings, ModelCatalog, AgentProvider } from '../shared/types';
function agentFields(provider: AgentProvider, settings: Settings) {
  const name = provider === 'claude' ? 'Claude' : 'Codex';
  return `<fieldset class="agent-settings"><legend>${name}</legend><label>${name} executable<input name="${provider}Path" value="${escape(settings.agent[`${provider}Path`])}" required></label><label>${name} model<select name="${provider}Model"><option value="">Use CLI default</option><option value="__custom__">Custom model…</option></select></label><label data-custom="${provider}" hidden>Custom ${name} model<input name="${provider}CustomModel" placeholder="Model name or alias"></label><div class="model-discovery"><small id="${provider}-models-status" role="status">Loading available models…</small><button type="button" data-refresh-models="${provider}">Refresh</button></div></fieldset>`;
}
export async function showSettings(context: { user: User; prefs: any; markPreference: (key: string, value: any) => void; exportAll: () => Promise<void>; importFiles: (files: FileList) => Promise<void>; account: () => void }) {
  const d = dialog('Settings', '<p>Loading settings…</p>');
  try {
    const [settings, runner, estimate] = await Promise.all([api<Settings>('/settings'), api('/runner'), navigator.storage.estimate()]);
    d.innerHTML = `<div class="dialog-heading"><h2>Settings</h2><button class="icon-button" data-close aria-label="Close">×</button></div><div class="settings-tabs"><button data-tab="general" class="selected">General</button><button data-tab="agents">Agents</button><button data-tab="storage">Storage & HTTPS</button>${context.user.admin ? '<button data-tab="users">Accounts</button>' : ''}</div><form id="settings-form"><section data-section="general"><label>Appearance<select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label>Save after typing stops (milliseconds)<input name="idleMs" type="number" min="100" max="10000" value="${settings.idleMs}" required></label><label>Maximum save interval (milliseconds)<input name="maxSaveMs" type="number" min="100" max="30000" value="${settings.maxSaveMs}" required></label><p class="muted">Typing and navigation stay local. These intervals control background server saves.</p></section><section data-section="agents" hidden><p class="runner-status">${runner.ok ? `Connected · running as ${escape(runner.user)}` : 'Agent execution is unavailable. Restart Garnet.'}</p><p class="muted">Agents use the host account’s full access and existing CLI logins.</p><label>Default agent<select name="provider"><option value="claude">Claude</option><option value="codex">Codex</option></select></label>${agentFields('claude', settings)}${agentFields('codex', settings)}<label>Working directory<input name="cwd" value="${escape(settings.agent.cwd)}" placeholder="Host account home directory"></label><label>Job timeout (minutes)<input name="timeoutMinutes" type="number" min="1" max="240" value="${settings.agent.timeoutMinutes}" required></label></section><section data-section="storage" hidden><p>${Math.round((estimate.usage || 0) / 1024 / 1024)} MB used locally · ${Math.round((estimate.quota || 0) / 1024 / 1024)} MB browser quota</p><button type="button" id="persistent-storage">Keep offline storage</button><p class="muted">The whole text library downloads in the background. Browser storage limits still apply.</p><div class="inline-actions"><button type="button" id="export-all">Export library ZIP</button><label class="file-button">Import Markdown<input id="import-files" type="file" accept=".md,.markdown,text/markdown,text/plain" multiple hidden></label></div><label>Revisions per document<input name="revisionLimit" type="number" min="1" max="1000" value="${settings.revisionLimit}" required></label><label>Trash retention (days)<input name="trashDays" type="number" min="1" max="3650" value="${settings.trashDays}" required></label><label>Private HTTPS hostname or IP<input name="httpsAddress" value="${escape(settings.httpsAddress)}" placeholder="localhost"></label><p class="muted">Use an address that resolves to this host. HTTPS listens on port 8443. Download and trust the local CA on each device before using offline mode.</p><a class="button" href="/api/certificate" download>Download local CA certificate</a><p class="muted">Markdown mirrors: ./data/documents<br>Database: ./data/mongo-host<br>Stored directly on the host.</p></section><p class="error" role="alert" id="settings-error"></p><button class="primary" id="save-settings">Save settings</button></form>${context.user.admin ? '<section data-section="users" hidden><div id="account-list"></div><h3>Create account</h3><form id="new-account"><label>Username<input name="username" autocomplete="off" pattern="[a-zA-Z0-9_.-]{1,40}" required></label><label>Initial password<input name="password" type="password" autocomplete="new-password" minlength="10" required></label><label class="checkbox"><input name="admin" type="checkbox">Administrator</label><button class="primary">Create account</button><p class="muted">New accounts must change their password on first login.</p></form></section>' : ''}`;
    d.querySelector('[data-close]')!.addEventListener('click', () => d.close());
    const theme = d.querySelector<HTMLSelectElement>('#theme')!; theme.value = context.prefs.theme || 'system'; theme.onchange = () => { document.documentElement.dataset.theme = theme.value; context.markPreference('theme', theme.value); };
    d.querySelector<HTMLSelectElement>('[name=provider]')!.value = settings.agent.provider;
    const refreshers: (() => void)[] = [];
    for (const provider of ['claude', 'codex'] as const) {
      const select = d.querySelector<HTMLSelectElement>(`[name=${provider}Model]`)!;
      const custom = d.querySelector<HTMLInputElement>(`[name=${provider}CustomModel]`)!;
      const executable = d.querySelector<HTMLInputElement>(`[name=${provider}Path]`)!;
      const status = d.querySelector<HTMLElement>(`#${provider}-models-status`)!;
      const button = d.querySelector<HTMLButtonElement>(`[data-refresh-models=${provider}]`)!;
      let generation = 0;
      custom.value = settings.agent[`${provider}Model`]; select.value = custom.value ? '__custom__' : '';
      const customVisibility = () => { (custom.closest('label') as HTMLElement).hidden = select.value !== '__custom__'; custom.required = select.value === '__custom__'; };
      select.onchange = customVisibility; customVisibility();
      const load = async (refresh = false) => {
        const request = ++generation; status.textContent = 'Loading available models…'; button.disabled = true;
        try {
          const catalog = await api<ModelCatalog>('/agent-models', 'POST', { provider, executable: executable.value, cwd: d.querySelector<HTMLInputElement>('[name=cwd]')!.value, refresh });
          if (request !== generation || !d.isConnected) return;
          const selected = select.value === '__custom__' ? custom.value : select.value;
          select.innerHTML = `<option value="">Use CLI default</option>${catalog.models.map(model => `<option value="${escape(model.id)}">${escape(model.name)}${model.name !== model.id ? ` · ${escape(model.id)}` : ''}</option>`).join('')}<option value="__custom__">Custom model…</option>`;
          select.value = !selected || catalog.models.some(model => model.id === selected) ? selected : '__custom__';
          if (select.value === '__custom__') custom.value = selected;
          customVisibility(); status.textContent = catalog.error || (catalog.models.length ? `${catalog.models.length} models available` : 'No models returned. Use the CLI default or a custom model.');
        } catch (error: any) { if (request === generation) status.textContent = error.message; }
        finally { if (request === generation) button.disabled = false; }
      };
      executable.onchange = () => void load(); button.onclick = () => void load(true);
      refreshers.push(() => void load()); void load();
    }
    d.querySelector<HTMLInputElement>('[name=cwd]')!.onchange = () => refreshers.forEach(refresh => refresh());
    d.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => { d.querySelectorAll('[data-section]').forEach(section => (section as HTMLElement).hidden = (section as HTMLElement).dataset.section !== button.dataset.tab); d.querySelectorAll('[data-tab]').forEach(tab => tab.classList.toggle('selected', tab === button)); (d.querySelector('#save-settings') as HTMLElement).hidden = button.dataset.tab === 'users'; });
    d.querySelector<HTMLFormElement>('#settings-form')!.onsubmit = async e => {
      e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement));
      const next: Settings = { idleMs: Number(data.idleMs), maxSaveMs: Number(data.maxSaveMs), trashDays: Number(data.trashDays), revisionLimit: Number(data.revisionLimit), httpsAddress: String(data.httpsAddress).trim(), agent: { provider: data.provider as 'claude' | 'codex', claudePath: String(data.claudePath), codexPath: String(data.codexPath), claudeModel: String(data.claudeModel === '__custom__' ? data.claudeCustomModel : data.claudeModel).trim(), codexModel: String(data.codexModel === '__custom__' ? data.codexCustomModel : data.codexModel).trim(), cwd: String(data.cwd), timeoutMinutes: Number(data.timeoutMinutes) } };
      try { await api('/settings', 'PUT', next); toast('Settings saved.'); } catch (error: any) { d.querySelector('#settings-error')!.textContent = error.message; }
    };
    d.querySelector('#persistent-storage')!.addEventListener('click', async () => toast(await navigator.storage.persist() ? 'Persistent offline storage enabled.' : 'Your browser manages storage automatically. Keep a library export as a backup.'));
    d.querySelector('#export-all')!.addEventListener('click', () => context.exportAll().catch(error => toast(error.message)));
    d.querySelector<HTMLInputElement>('#import-files')!.onchange = e => { const files = (e.target as HTMLInputElement).files; if (files) { void context.importFiles(files); d.close(); } };
    if (context.user.admin) {
      const refresh = async () => { const users = await api<User[]>('/users'); d.querySelector('#account-list')!.innerHTML = users.map(u => `<p class="account-row"><span>${escape(u.username)}</span><small>${u.admin ? 'Admin' : 'User'}${u.mustChangePassword ? ' · Initial password' : ''}</small></p>`).join(''); }; await refresh();
      d.querySelector<HTMLFormElement>('#new-account')!.onsubmit = async e => { e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const data = Object.fromEntries(new FormData(form)); try { await api('/users', 'POST', { ...data, admin: data.admin === 'on' }); form.reset(); await refresh(); toast('Account created.'); } catch (error: any) { toast(error.message); } };
    }
  } catch (error: any) { d.querySelector('p')!.textContent = `Settings need a server connection. ${error.message}`; }
}
