import './style.css';
import { api, setCsrf, escape } from './api';
import type { User } from '../shared/types';
// Cache the app shell independently of document synchronization.
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
const root = document.querySelector<HTMLDivElement>('#app')!;
// `signedOut` marks an account whose session the server has ended, until someone signs in again.
const cached = (() => { try { const value = localStorage.getItem('ed-user'); return value ? JSON.parse(value) as User & { signedOut?: boolean } : undefined; } catch { return undefined; } })();
const workspace = cached ? import('./workspace') : undefined;
workspace?.catch(() => {});
const session = api<{ user: User; csrf: string }>('/me');
session.catch(() => {});
// Nothing of the app is shown to a page the server has signed out, so a remembered account waits
// for the session check. No answer in time (offline, a server that cannot be reached) is not a
// sign-out: the local copy opens, as it does offline, and its first sync learns the answer.
const signedOut = Promise.race([session.then(() => false, error => error?.status === 401), new Promise<boolean>(resolve => setTimeout(resolve, 3000, false))]);
const unreachable = (error: any) => error?.status === 401 ? '' : 'Garnet can’t be reached right now. Check your connection, then try again.';
async function enter(user: User) {
  localStorage.setItem('ed-user', JSON.stringify(user));
  if (user.mustChangePassword) return passwordScreen();
  const { start } = await (workspace ?? import('./workspace')); await start(user);
}
function loginScreen(error = '', username = '') {
  root.innerHTML = `<main class="auth"><div class="wordmark">Garnet<span>shared notes</span></div><h1>A place for your thoughts.</h1><p>Open a document. Pick up where you left off.</p><form id="login"><label>Username<input name="username" value="${escape(username)}" autocomplete="username" required${username ? '' : ' autofocus'}></label><label>Password<input name="password" type="password" autocomplete="current-password" required${username ? ' autofocus' : ''}></label><p class="error" role="alert">${escape(error)}</p><button class="primary">Sign in</button></form><small>First setup: admin / password. You’ll change it next.</small></main>`;
  root.querySelector('form')!.onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const data = Object.fromEntries(new FormData(form)); const button = form.querySelector('button')!; button.disabled = true;
    try { const result = await api('/login', 'POST', data); setCsrf(result.csrf); await enter(result.user); } catch (error: any) { loginScreen(error.message, String(data.username)); }
  };
}
// Signing in from another tab signs in a tab waiting at the sign-in page too.
window.addEventListener('storage', event => { try { if (event.key === 'ed-user' && event.newValue && root.querySelector('#login') && !JSON.parse(event.newValue).signedOut) location.reload(); } catch {} });
function passwordScreen() {
  root.innerHTML = `<main class="auth"><div class="wordmark">Garnet</div><h1>Make this account yours.</h1><p>Change your initial password to continue.</p><form><label>Current password<input name="current" type="password" autocomplete="current-password" required></label><label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="256" required></label><label>Confirm new password<input name="confirm" type="password" autocomplete="new-password" required></label><p class="error" role="alert"></p><button class="primary">Change password</button></form></main>`;
  root.querySelector('form')!.onsubmit = async e => { e.preventDefault(); const form = e.currentTarget as HTMLFormElement; const data = Object.fromEntries(new FormData(form)); try { if (data.password !== data.confirm) throw new Error('Passwords do not match.'); await api('/password', 'POST', data); const me = await api('/me'); await enter(me.user); } catch (error: any) { form.querySelector('.error')!.textContent = error.message; } };
}
// A returning user starts from the cached account, which is on this device, unless the server
// says the session has ended: then only the sign-in page is shown, and signing in reopens the local copy.
if (cached && !cached.mustChangePassword && !cached.signedOut) {
  if (await signedOut) { try { localStorage.setItem('ed-user', JSON.stringify({ ...cached, signedOut: true })); } catch {} loginScreen('', cached.username); }
  else try { const { start } = await workspace!; await start(cached, session); } catch { loginScreen('Local storage is unavailable. Reconnect to sign in.'); }
} else {
  let result: Awaited<typeof session> | undefined;
  try { result = await session; } catch (error) { loginScreen(unreachable(error), cached?.signedOut ? cached.username : ''); }
  if (result) try { setCsrf(result.csrf); await enter(result.user); } catch { loginScreen(); }
}
