// Injected into every page before application scripts. It only observes: key
// latency, long animation frames, fetches, and IndexedDB writes. Serialized by
// Playwright, so it must not reference anything outside its own body.
export function instrument() {
  const now = () => performance.now();
  const P: any = (window as any).__perf = { marks: {}, keys: [], loaf: [], requests: {}, seen: [], inflight: 0, lastActivity: 0, idbWrites: 0, recording: false, recordStart: 0 };
  const touch = () => { P.lastActivity = now(); };
  // Resolves just after the frame in which `ready()` first holds has painted.
  P.painted = (ready: () => unknown, timeout = 60000) => new Promise<number>((resolve, reject) => {
    const start = now();
    const frame = () => {
      let ok = false; try { ok = Boolean(ready()); } catch { /* keep polling */ }
      if (ok) { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(now()); channel.port2.postMessage(0); }
      else if (now() - start > timeout) reject(new Error('Timed out waiting for the page.'));
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  void P.painted(() => document.querySelector('.workspace')).then((t: number) => { P.marks.shell = t; });
  void P.painted(() => document.querySelector('.ProseMirror')?.textContent).then((t: number) => { P.marks.content = t; });
  try { new PerformanceObserver(list => { for (const e of list.getEntries() as any[]) { P.loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration }); touch(); } }).observe({ type: 'long-animation-frame', buffered: true }); } catch { /* unsupported */ }
  // Key-to-paint latency: from the OS/CDP event timestamp to just after the next frame.
  // (Event Timing durations are unreliable headless: keys that change nothing visible
  // can wait seconds for a presented frame.)
  addEventListener('keydown', e => {
    if (!P.recording) return;
    const stamp = e.timeStamp; const handler = now();
    requestAnimationFrame(() => { const frame = now(); const channel = new MessageChannel(); channel.port1.onmessage = () => P.keys.push({ delay: handler - stamp, frame: frame - stamp, paint: now() - stamp }); channel.port2.postMessage(0); });
  }, true);
  const fetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const key = `${init?.method || 'GET'} ${url.pathname.replace(/^(\/api\/(?:documents|jobs|conversations))\/[^/]+/, '$1/:id')}`;
    P.requests[key] = (P.requests[key] || 0) + 1; P.inflight++; touch();
    return fetch.call(this, input, init).finally(() => { P.inflight--; touch(); });
  };
  for (const method of ['put', 'add'] as const) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (this: IDBObjectStore, ...args: [any, IDBValidKey?]) { P.idbWrites++; touch(); return original.apply(this, args); };
  }
}
