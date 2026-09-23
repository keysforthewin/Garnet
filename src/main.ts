import './style.css';
import { api, setCsrf, escape } from './api';
import type { User } from '../shared/types';
// Cache the app shell independently of document synchronization.
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
const root = document.querySelector<HTMLDivElement>('#app')!;
const cached = (() => { try { const value = localStorage.getItem('ed-user'); return value ? JSON.parse(value) as User : undefined; } catch { return undefined; } })();
const workspace = cached ? import('./workspace') : undefined;
workspace?.catch(() => {});
const session = api<{ user: User; csrf: string }>('/me');
session.catch(() => {});
async function enter(user: User) {
  localStorage.setItem('ed-user', JSON.stringify(user));
  if (user.mustChangePassword) return passwordScreen();
  const { start } = await (workspace ?? import('./workspace')); await start(user);
}
function loginScreen(error = '') {
  root.innerHTML = `<main class="auth"><div class="wordmark">Garnet<span>shared notes</span></div><h1>A place for your thoughts.</h1><p>Open a document. Pick up where you left off.</p><form id="login"><label>Username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p class="error" role="alert">${escape(error)}</p><button class="primary">Sign in</button></form><small>First setup: admin / password. You’ll change it next.</small></main>`;
  root.querySelector('form')!.onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const data = Object.fromEntries(new FormData(form)); const button = form.querySelector('button')!; button.disabled = true;
    try { const result = await api('/login', 'POST', data); setCsrf(result.csrf); await enter(result.user); } catch (error: any) { loginScreen(error.message); }
  };
}
function passwordScreen() {
  root.innerHTML = `<main class="auth"><div class="wordmark">Garnet</div><h1>Make this account yours.</h1><p>Change your initial password to continue.</p><form><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" required></label><label>Confirm new password<input name="confirm" type="password" autocomplete="new-password" required></label><p class="error" role="alert"></p><button class="primary">Change password</button></form></main>`;
  root.querySelector('form')!.onsubmit = async e => { e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const data = Object.fromEntries(new FormData(form)); try { if (data.password !== data.confirm) throw new Error('Passwords do not match.'); await api('/password', 'POST', data); const me = await api('/me'); await enter(me.user); } catch (error: any) { form.querySelector('.error')!.textContent = error.message; } };
}
// A returning user starts from the cached account, as offline, without waiting for the
// session check. The workspace finishes the check and asks to sign in again if it expired.
if (cached && !cached.mustChangePassword) {
  try { const { start } = await workspace!; await start(cached, session); } catch { loginScreen('Local storage is unavailable. Reconnect to sign in.'); }
} else {
  try { const result = await session; setCsrf(result.csrf); await enter(result.user); } catch { loginScreen(); }
}
