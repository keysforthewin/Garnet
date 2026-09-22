# Garnet

A lightweight shared notes app built to load fast and keep up with your ideas. Write together with live cursors, save locally as you type, and bring your Claude or Codex agents directly into your documents.

**Free. Open source. [MIT licensed](LICENSE).**

![Garnet's editor with a populated notes library and a launch-day document](docs/media/garnet/editor.png)

## Garnet in 30 seconds

Three square, silent demos with text overlays. Play them inline below, or use the previews to open the repository MP4s.

| Your brain hates loading screens | One doc. Multiple brains. | Your notes brought backup |
| --- | --- | --- |
| [![Watch the speed demo](docs/media/garnet/01-speed-poster.png)](docs/media/garnet/01-speed.mp4?raw=true) | [![Watch the collaboration demo](docs/media/garnet/02-together-poster.png)](docs/media/garnet/02-together.mp4?raw=true) | [![Watch the agent demo](docs/media/garnet/03-agents-poster.png)](docs/media/garnet/03-agents.mp4?raw=true) |
| [Watch / download MP4](docs/media/garnet/01-speed.mp4?raw=true) | [Watch / download MP4](docs/media/garnet/02-together.mp4?raw=true) | [Watch / download MP4](docs/media/garnet/03-agents.mp4?raw=true) |

**Your brain hates loading screens** — lightweight editing, worker-powered search, and local autosave.

https://github.com/user-attachments/assets/da659fc9-6f9f-4750-a340-9c04ac6b361f

**One doc. Multiple brains.** — shared cursors, live edits, and incremental sync.

https://github.com/user-attachments/assets/6f310003-e1c1-481a-ac6a-430c5737631f

**Your notes brought backup** — your Claude or Codex, right inside your documents.

https://github.com/user-attachments/assets/dee33333-938b-4121-ab75-80b5cf6440a5

[Overlay scripts and ready-to-post X copy](docs/media/garnet/COPY.md) · [Local video player](docs/media/garnet/index.html) (open in a browser after cloning).

- **Keep the editor moving.** A Web Worker handles library search off the UI thread. Editing and cached navigation happen locally.
- **Save as you write.** Local autosave keeps your changes on the device; background sync and server persistence have distinct status indicators.
- **Write together.** Live cursors and incremental Yjs updates keep collaboration responsive. Background library caching supports offline work.
- **Bring your agents.** Claude and Codex can read and edit documents through Garnet's tools, using your existing host CLI accounts. Agent service usage is separate from the free app.
- **Pick up offline.** A service worker caches the app shell, and IndexedDB stores your documents. Reconnect to merge changes.

<details>
<summary>See collaboration and agents in action</summary>

**Live collaboration:** Alex and Sam editing the same launch checklist.

![Two people editing a Garnet document with a named live cursor](docs/media/garnet/collaboration.png)

**Claude:** rough notes become a launch checklist in the active document.

![Claude's completed conversation beside the checklist it created](docs/media/garnet/claude.png)

**Codex:** the checklist gets an owner for each next step.

![Codex's completed conversation beside the document with assigned owners](docs/media/garnet/codex.png)

These captures use fictional demo notes and real agent runs. Agent waiting is shortened and labeled in the videos. [Capture and rendering instructions](scripts/media/README.md).

</details>

Public address: **https://garnet.outdoordevs.com**, routed through the existing Cloudflare tunnel to **http://localhost:7777**. Cloudflare supplies the public HTTPS certificate; the local CA instructions below apply only to direct LAN access.

## Start

Requirements: Linux, Docker Compose, and Node 22+ on the host for the optional agent runner. The default service UID/GID is `1000:1000`, matching this workspace's owner.

```sh
./garnet build
./garnet start
./garnet install-runner
```

Open **http://localhost:7777**. Sign in with **admin / password** and set a new password. The bootstrap login cannot access documents, settings, collaboration, or agents until its password changes. Normal restarts never reset it.

The runner uses your existing `claude` and `codex` logins. You can run it in the foreground with `./garnet runner` instead of installing the user service. Settings → Agents lets you choose executable paths, model overrides, working directory, and job timeout. The default working directory is the host user's home. Every signed-in user may invoke either agent with that host account's full access.

No `.env` file is used. App settings live in Mongo and are edited in the UI. Fixed bootstrap addresses, host bind mounts, and service ports live in Compose; these must exist before Mongo-backed configuration can be read. CLI authentication remains managed by the respective host CLI.

The Compose project, Mongo database, cookies, and browser-storage identifiers retain their original internal names for data compatibility. `./ed` remains an alias for `./garnet`.

## Private-network HTTPS and offline use

1. Open Settings → Storage & HTTPS on localhost.
2. Set a hostname or LAN/VPN IP that resolves to this host, then save.
3. Download the local CA certificate and install it as a trusted certificate on each device.
4. Open `https://YOUR-HOST:8443`. Caddy reloads its generated configuration automatically.

The HTTP bootstrap port is bound only to host loopback. Caddy's HTTPS port is available to the private network. Changing the HTTPS address changes the browser origin, so the new origin needs its own login and background cache download. Local certificate installation is an operating-system/browser operation and cannot be automated by a web page.

The sidebar reports how many documents are ready offline. The whole text library downloads in the background. After the application has loaded and caching finishes, you can reopen it offline, edit existing documents, and create new ones. Browser storage quotas and eviction policies still apply; use “Keep offline storage” and periodic exports. Agent jobs and shared settings require a server connection. Offline AI prompts remain drafts.

## Editing

- One click opens a document at your saved selection and scroll position.
- `Ctrl/Cmd+K` focuses library search; `Alt+N` creates a note; `Ctrl/Cmd+J` opens AI; `Ctrl/Cmd+\` toggles the sidebar.
- Formatting supports headings, emphasis, links, lists, checkboxes, quotes, code blocks, and simple tables. Markdown is the import/export format; whitespace and formatting syntax are normalized.
- Changes display immediately. “Saving locally,” “Saved locally · syncing,” and “Saved to server” reflect distinct persistence states.
- Server snapshots are saved after 750 ms idle, at least every 5 seconds during continuous typing. Collaborators receive updates immediately.
- Document options include pin, duplicate, trash, and version history. Trash restores are shared actions.
- Export downloads current local content, including pending edits. Library ZIP export runs locally. Original imports are retained on the importing device for recovery.

Mongo holds binary Yjs state, metadata, revisions, accounts, sessions, settings, preferences, and agent conversations. Plain Markdown is an asynchronous projection; it is not sufficient to recreate collaboration history or accounts.

## Host directories

| Directory | Purpose |
| --- | --- |
| `build/` | Fully built application, host runner, and production dependencies |
| `data/documents/` | Markdown mirrors, using `title--document-id.md` filenames |
| `data/documents/.trash/` | Mirrors for trashed documents |
| `data/mongo/` | Mongo data files |
| `data/runtime/` | Private runner/app sockets and generated Caddy configuration |
| `data/caddy/`, `data/caddy-config/` | HTTPS certificate authority and Caddy state |

The builder is a disposable Node container. Source is bind-mounted read-only; compilation runs in disposable storage and writes completed artifacts to the host. Runtime containers mount `build/` read-only and do not install or compile code. Application code is never baked into an image. The host runner is the explicit exception to Docker-only services, allowing your existing host CLIs and credentials to work normally.

Direct edits to mirror files are **not imported**. Agents use the Garnet library's MCP tools for document changes. Those tools read live content and require a matching content version before edits, preserving concurrent human work. Requests may target the current document, another document, or the library. Full-host agent actions outside the library remain ordinary host actions.

## Operations

```sh
./garnet logs
./garnet stop
./garnet update
systemctl --user status garnet-runner
systemctl --user restart garnet-runner
```

`./garnet update` rebuilds and recreates app/HTTPS services. Restart the runner after updating its build. A service-worker update activates once older app tabs close. Keep all tabs on the same application version when modifying the editor schema.

For a portable backup, stop the app and runner, run `mongodump --archive` inside the Mongo service, and copy the Markdown and Caddy directories. For a raw directory backup, stop all services before copying `data/`; do not copy live Mongo data files. Restore to stopped services, preserve ownership, then restart. Mongo state regenerates Markdown mirrors at app startup. Keep the Caddy CA when restoring if existing devices should retain certificate trust.

Health is available at `/api/health`. Settings shows runner connectivity; the UI reports local storage, sync, and mirror failures. Interrupted agent jobs are not automatically rerun, because host commands may already have taken effect.

## Development and verification

```sh
npm ci
npm run check
npm test
./garnet build
mkdir -p data/test-documents data/test-runtime
docker compose --profile test up -d mongo test-app
npm run test:e2e
```

Browser tests use a separate `ed_test` database and `data/test-*` mounts on port 8081. The serial bootstrap test assumes a fresh test database. Reset **only that test database** with `docker compose exec mongo mongosh ed_test --quiet --eval 'db.dropDatabase()'`, then recreate `test-app` before rerunning the whole suite. Production data uses `ed` and is untouched by test resets.

`build/bundle-sizes.json` records gzip sizes. Screenshots and browser traces are written to `test-results/`. Performance targets apply to small text documents; attachments, raw Markdown source editing, multi-host scaling, and external filesystem editing are outside this version.

Measured on this Linux host with Chromium 153 and 500 documents of 19,390 bytes each: p95 cached open **47.3 ms**, typing-to-next-frame **11.8 ms**, and local search **55.9 ms**. Raw samples are in `verification/benchmark.json`. These are local measurements, not guarantees for every device.

The browser suite covers three simultaneous editors, offline reload/reconnection, cursor restoration, access restrictions, Markdown export, trash/restore, server outages, failed mirror writes, stale restore rejection, duplicate requests, and an injected local-storage quota failure with in-memory export. `scripts/smoke-agents.mjs` exercises real Claude/Codex document creation, session continuation, edits, and cancellation against the disposable test app. It requires a host runner started with `node build/runner.mjs --runtime "$PWD/data/test-runtime"` and uses your existing CLI accounts.
