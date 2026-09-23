# Frontend performance

`scripts/perf/` measures the browser app end to end so a change can be judged by numbers rather than feel. Each run starts a private MongoDB (`mongod` must be on `PATH`, or pass `--mongo mongodb://host:port`), seeds a 500-document library plus one ~200 KB document, starts the built server, and drives Chromium with Playwright.

```sh
npm run build
npm run perf -- --label after                  # measures ./build
npm run perf -- --ref HEAD --label before      # builds another revision in a temporary worktree first
npm run perf:compare perf-results/before.json perf-results/after.json
```

A full run takes about ten minutes. `--quick` runs fewer rounds, and `--only warmLoad,typing` selects scenarios. Results are written to `perf-results/<label>.json` (ignored by git) with every raw sample.

## Conditions

- **4× CPU slowdown** by default (`--cpu 1` to disable). This approximates a mid-range laptop or phone, and makes differences larger than run-to-run noise.
- 500 documents of about 19 KB each, plus a large document with headings, lists, tasks, tables and code.
- Loopback networking. Real deployments add round trips, so load-time savings that remove a request are larger in practice.

## Scenarios and metrics

Every metric is lower-is-better.

| Scenario | What happens | Key metrics |
| --- | --- | --- |
| `bundle` | Static sizes of the built assets | total JS gzip/raw, CSS gzip |
| `coldLoad` | New device: no service worker or IndexedDB, signed in | `shellMs` (workspace painted), `contentMs` (a document painted), JS/CSS bytes before the shell |
| `warmLoad` | Returning user: library cached, service worker installed but stopped | `fcpMs`, `contentMs`, `settledMs` (network and IndexedDB quiet), `cpuMs`, `blockingMs` (long-animation-frame blocking), `idbWrites`, `requests`, `heapMB` |
| `navigation` | Open the menu and switch documents | `menuOpenMs`, `firstOpenMs`, `reopenMs`, `largeFirstOpenMs`, `largeReopenMs` (click to painted) |
| `search` | Type a query into the menu search | `narrowMs` (one result), `broadMs` (every document) |
| `typing` | Sentences typed at 70 ms per key with a 1.2 s pause after each, so autosave and sync overlap later keystrokes | `keyToPaintMs` (per key, from the input event timestamp to just after the next frame), `inputDelayMs`, `cpuPerSentenceMs`, script/layout/style time per key, `longFrames`, `requests`, `idbWrites` |
| `typingLarge` | The same in the ~200 KB document | as `typing` |
| `collaboration` | A second client edits the same document from Node every 150 ms while the browser user types | as `typing`, plus `remoteToPaintMs` (remote keystroke to painted in the browser) |

`compare.ts` reports medians, p95 and a two-sided Mann–Whitney U test. A metric is marked BETTER or WORSE only when p < 0.05 and the median moved at least 5%. Session-level metrics have few samples, so treat their verdicts as indicative.

## Profiling

`--profile` saves a CPU profile of one measured window per scenario (`perf-results/<label>-<scenario>.cpuprofile`, openable in Chrome DevTools). Profiling adds overhead, so compare profiled runs only with each other. For readable function names, profile an unminified build (for example, a worktree whose `vite.config.ts` sets `minify: false`):

```sh
npm run perf -- --profile --only typingLarge --label investigate
npm run perf:profile perf-results/investigate-typingLarge.cpuprofile
```

## Results: September 2026 optimization pass

`df2017e` compared with the optimized working tree, measured back to back on the development host (Chromium 153, 4× CPU slowdown, 500 documents). Medians unless noted. Every row is a statistically clear improvement, except the menu open time, which did not change.

| Scenario | Metric | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| New device | Document visible | 9,240 ms | 653 ms | −93% |
| New device | JS before first paint | 210 KB | 193 KB | −8% |
| Returning user | First paint | 998 ms | 320 ms | −68% |
| Returning user | Document visible | 1,221 ms | 687 ms | −44% |
| Returning user | Main-thread CPU to settle | 1,887 ms | 684 ms | −64% |
| Returning user | JS heap | 33.5 MB | 5.9 MB | −82% |
| Returning user | IndexedDB writes per load | 1,008 | 7 | −99% |
| Switch document | First open / reopen | 141 / 107 ms | 101 / 68 ms | −28% / −36% |
| Search | One match / all match | 25.6 / 125 ms | 17.6 / 65.7 ms | −31% / −47% |
| Typing | Key to paint, p50 / p95 | 21.7 / 29.7 ms | 17.4 / 22.6 ms | −20% / −24% |
| Typing | Requests / IndexedDB writes per session | 71 / 10,112 | 14 / 478 | −80% / −95% |
| Typing, 200 KB document | Key to paint, p50 / p95 | 1,903 / 3,720 ms | 61 / 208 ms | −97% / −94% |
| Collaboration | Key to paint, p50 / p95 | 25.0 / 40.0 ms | 18.2 / 26.7 ms | −27% / −33% |
| Collaboration | Remote edit to paint, p50 / p95 | 28 / 52 ms | 20 / 35 ms | −29% / −33% |

What changed:

- **Sync no longer rewrites the library.** A pull stores only records whose metadata changed, instead of every record; that was two full rewrites per load and one per server save. Server events apply the single changed document instead of triggering a full pull. Queued edits push without pulling. Documents with a connected editor are not downloaded again, because the socket already delivers their content.
- **Metadata and content are stored separately.** IndexedDB version 2 moves Yjs state and Markdown into a `content` store and migrates existing caches in place. Startup reads only metadata, the open document's content loads on demand, and the search worker reads Markdown itself, off the main thread. A tab still running the old version blocks the upgrade until it is closed, and the new version asks the user to close it.
- **Per-keystroke work is deferred.** Local snapshots, which re-encode the whole document, run in idle time after typing pauses, at most five seconds apart; every update is already durable in y-indexeddb. Word count, cursor saving and toolbar state are debounced or coalesced into one animation frame. Persistence acknowledgements sign the live document from Yjs's struct store instead of encoding it.
- **Load has fewer steps in series.** The workspace code downloads while the session check is in flight. A new device downloads and opens the document being restored before the rest of the library. Markdown conversion, and its parser, is a separate chunk loaded after the editor appears. The live editor no longer includes Tiptap's Markdown extension, which built a converter on every document switch. The service worker enables navigation preload.
- **Smaller rendering costs.** The document list is drawn only while the menu is open, uses one delegated click handler, and skips off-screen rows with `content-visibility`. HTML escaping no longer creates a DOM node per call; it now also escapes quotes, which closes an attribute injection through document titles. The search index stores lowercase text once instead of rebuilding it on every query. The agent panel stops refreshing its document list while hidden.

## Results: second pass

The first pass's result compared with this pass, measured back to back on the same host with the same harness (Chromium 153, 4× CPU slowdown, 500 documents). Medians. New-device rows and per-session typing counts have few samples, so treat them as indicative.

| Scenario | Metric | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| Returning user | Document visible | 721 ms | 548 ms | −24% |
| Returning user | Network and storage settled | 1,329 ms | 1,133 ms | −15% |
| Returning user | Main-thread CPU to settle | 702 ms | 619 ms | −12% |
| Returning user | Requests per load | 5 | 4 | −20% |
| New device | Document visible | 680 ms | 607 ms | −11% |
| New device | JS before first paint | 193 KB | 157 KB | −19% |
| Switch document | Reopen a recent document | 68 ms | 40 ms | −41% |
| Switch document | Reopen the 200 KB document | 376 ms | 247 ms | −34% |
| Typing, 200 KB document | Long frames per session | 122 | 59 | −52% |
| Typing, 200 KB document | Blocking time per session | 557 ms | 302 ms | −46% |
| Typing, 200 KB document | Main-thread CPU per sentence | 3,398 ms | 3,206 ms | −6% |
| Bundle | All JavaScript, gzip | 220 KB | 351 KB | +59% |

Key-to-paint latency, search, menu opening and collaboration did not change measurably.

What changed:

- **Snapshots run in a worker.** The library worker, which already held the search index, keeps a copy of each open document. It loads the same stored state as the page (the last snapshot plus y-indexeddb's updates) and receives every later Yjs update. When typing pauses, it encodes the document, converts it to Markdown, stores both and indexes the text; the page only posts messages. Imports, exports of open documents and merges of offline edits into closed documents also convert there, so the page no longer loads the Markdown converter. The worker starts once the first document is on screen.
- **Recent editors stay alive.** The last four editors are kept off the page. Returning to one reattaches it, with its selection, undo history and word count, instead of rebuilding the schema, plugins and DOM. Kept editors keep applying collaborators' edits, and leaving a document clears this person's caret there. Each document has its own awareness, so an editor shows carets without waiting for its provider.
- **Returning users start before `/api/me`.** The workspace opens from the cached account while the session is checked, and the first sync uses that check. If the session expired, the sign-in dialog opens over the documents, which stay usable from the local copy. If the server reports another account, or one that must change its password, the page reloads as that account. A link to a document this device has not downloaded yet opens when sync brings it, as at startup.
- **Collaboration code loads when needed.** The Hocuspocus provider is a separate 6.6 KB (gzip) chunk, loaded when the first document connects.
- **Pre-compressed assets.** The build writes Brotli (quality 11) and gzip (level 9) copies of every asset, and the server sends the one the browser accepts. The editor chunk is 155 KB with Brotli instead of 182 KB with gzip.

Costs and measurement notes:

- The worker repeats Yjs, Tiptap and the Markdown parser, which adds 150 KB (gzip) to the one-time download. The service worker caches it with the rest of the app.
- Each open document has a second copy in the worker's memory.
- CPU metrics cover the page's main thread only, and `idbWrites` counts only the page's writes. Snapshot work and its IndexedDB writes now happen in the worker, so they no longer appear in either.

## Further opportunities

Measured or profiled but not yet implemented, roughly in order of value:

1. **Skip layout of off-screen editor content.** Reopening the 200 KB document still spends about 140 ms at 4× on style and layout of the reattached DOM (script is about 45 ms), and typing in it costs about 7 ms of layout per key. `content-visibility: auto` on top-level blocks could skip off-screen content. It needs care with caret positioning, scroll anchoring and estimated heights.
2. **Faster first library download.** A new device downloads documents one request at a time. Limited concurrency, or a bulk state endpoint, would shorten the time until the whole library is available offline. The document being opened is already fetched first.
3. **Incremental library sync.** The 20-second safety-net sync downloads every document's metadata. A `?since=` parameter would make it proportional to changes.
4. **A smaller worker.** Converting to Markdown without Tiptap's extension classes would shrink the worker, but its output must stay identical to the server's.
5. **No snapshot after opening.** The worker stores a fresh snapshot of each document it opens, even when nothing changed since the stored one. Comparing Yjs snapshots after loading would skip that work.

Limits that belong to the libraries or the browser, not the app:

- y-prosemirror compares the whole top-level document with the Yjs fragment after every keystroke, and Tiptap's collaboration caret dispatches an extra transaction for each awareness change. Both grow with document size.
- On every caret movement, Chromium computes the caret's text offset from the start of the editable element (`Editor::SyncSelection`), which costs about 14 ms per key at 4× in the middle of the 200 KB document.
