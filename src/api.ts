export let csrf = '';
export function setCsrf(value: string) { csrf = value; }
export async function api<T = any>(url: string, method = 'GET', body?: any): Promise<T> {
  const response = await fetch(`/api${url}`, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const error = await response.json().catch(() => ({ error: response.statusText })); throw Object.assign(new Error(error.error), { status: response.status }); }
  return response.json();
}
// Safe in text and quoted attribute values, without creating a DOM node per call.
const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escape(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, ch => entities[ch]); }
export function toast(message: string) {
  let region = document.querySelector<HTMLElement>('#toast');
  if (!region) { region = document.createElement('div'); region.id = 'toast'; region.setAttribute('role', 'status'); document.body.append(region); }
  region.textContent = message; region.hidden = false;
  clearTimeout((region as any).timer); (region as any).timer = setTimeout(() => { region!.hidden = true; }, 6000);
}
export function download(name: string, data: BlobPart, type = 'text/markdown;charset=utf-8') { const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([data], { type })); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function dialog(title: string, html: string) {
  const el = document.createElement('dialog'); el.innerHTML = `<div class="dialog-heading"><h2>${escape(title)}</h2><button class="icon-button" data-close aria-label="Close">×</button></div>${html}`;
  document.body.append(el); el.querySelector('[data-close]')!.addEventListener('click', () => el.close());
  el.addEventListener('click', e => { if (e.target === el) { const r = el.getBoundingClientRect(); if ((e as MouseEvent).clientX < r.left || (e as MouseEvent).clientX > r.right || (e as MouseEvent).clientY < r.top || (e as MouseEvent).clientY > r.bottom) el.close(); } });
  el.addEventListener('close', () => el.remove()); el.showModal(); return el;
}
