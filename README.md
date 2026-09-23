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
- **Save as you write.** Local autosave keeps your changes on the device; sync to the server happens in the background.
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

Requirements: Linux with systemd, Node 22+, MongoDB 8+, and optionally Caddy for direct LAN HTTPS. Put `node`, `npm`, `mongod`, and (if used) `caddy` on your host PATH.

```sh
./garnet build
./garnet install
```

Open **http://localhost:7777**. Sign in with **admin / password** and set a new password. The bootstrap login cannot access documents, settings, collaboration, or agents until its password changes. Normal restarts never reset it.

Garnet runs the web server and agent executor in **one Node process**, managed by the `garnet.service` user service. Claude and Codex run as short-lived subprocesses for model discovery and agent jobs, using your existing host CLI logins. There is no separate runner to start. Settings → Agents controls executable paths, separate Claude/Codex model choices, working directory, and timeout. Model lists come from the installed CLIs at startup and refresh when an executable or working directory changes. Each selector also supports the CLI default and a custom model. Discovery only initializes the CLI and requests its catalog; it sends no prompt. Codex uses its [model/list interface](https://learn.chatgpt.com/docs/app-server#list-models-modellist); Claude returns models during its CLI initialization handshake. Each signed-in user can invoke agents with the host account's full access.

The installer also creates a host MongoDB service on `127.0.0.1:27018`, with its own `data/mongo-host` directory. If Caddy is installed, it creates an optional HTTPS service on port 8443. These supporting services run directly on the host. To keep user services running after logout, enable lingering with `loginctl enable-linger "$USER"`.

For foreground use, start MongoDB and run `./garnet run`. Server options are `--host` (default `127.0.0.1`), `--port` (7777), `--mongo` (`mongodb://127.0.0.1:27018/ed`), `--storage`, `--runtime`, `--public`, and `--caddy-data`. App settings live in Mongo; CLI authentication stays with the host CLIs. `./ed` remains an alias for `./garnet`.

Existing installations must restore their database and certificate state before starting the host app; see [host migration](docs/host-migration.md).

## Private-network HTTPS and offline use

1. Open Settings → Storage & HTTPS on localhost.
2. Set a hostname or LAN/VPN IP that resolves to this host, then save.
3. Download the local CA certificate and install it as a trusted certificate on each device.
4. Open `https://YOUR-HOST:8443`. Caddy reloads its generated configuration automatically.

The HTTP bootstrap port is bound only to host loopback. Caddy's HTTPS port is available to the private network. Changing the HTTPS address changes the browser origin, so the new origin needs its own login and background cache download. Local certificate installation is an operating-system/browser operation and cannot be automated by a web page.

The whole text library downloads in the background. After the application has loaded and caching finishes, you can reopen it offline, edit existing documents, and create new ones. Browser storage quotas and eviction policies still apply; use “Keep offline storage” and periodic exports. Agent jobs and shared settings require a server connection. Offline AI prompts remain drafts.

## Editing

- One click opens a document at your saved selection and scroll position.
- `Ctrl/Cmd+K` focuses library search; `Alt+N` creates a note; `Ctrl/Cmd+J` opens AI; `Ctrl/Cmd+\` toggles the sidebar.
- Formatting supports headings, emphasis, links, lists, checkboxes, quotes, code blocks, and simple tables. Markdown is the import/export format; whitespace and formatting syntax are normalized.
- Changes display immediately and save locally before syncing in the background. Document actions, including Export, are in the top-left menu.
- Changed content saves after 750 ms idle, at least every 5 seconds during continuous typing. Unchanged content does not create a version, change the saved timestamp, or rewrite its Markdown mirror. Collaboration state remains durable.
- Version previews compare each saved version with its predecessor: green additions, red removals, and yellow changed passages. Old duplicate snapshots are omitted from the list without deleting history.
- Pin documents from the pin icon beside each sidebar row. The menu starts with Show/Hide sidebar, followed by New document (Alt+N), Export, Version history, and Settings. Move to trash is in its own bottom section. Trash restores are shared actions.
- Export downloads current local content, including pending edits. Library ZIP export runs locally.

Mongo holds binary Yjs state, metadata, revisions, accounts, sessions, settings, preferences, and agent conversations. Plain Markdown is an asynchronous projection; it is not sufficient to recreate collaboration history or accounts.

## Host directories

| Directory | Purpose |
| --- | --- |
| `build/` | Built frontend, integrated server, and agent document-tool adapter |
| `data/documents/` | Markdown mirrors, using `title--document-id.md` filenames |
| `data/documents/.trash/` | Mirrors for trashed documents |
| `data/mongo-host/` | Host Mongo data files |
| `data/runtime/` | Private document-tool socket and generated Caddy configuration |
| `data/caddy-host/` | HTTPS certificate authority and Caddy state |

Builds and runtime use the host Node installation and npm dependencies. `./garnet build` installs dependencies, checks TypeScript, runs unit tests, and builds the app. The agent executor is included in `build/server.mjs`; `build/tools.mjs` is the short-lived MCP adapter launched by agent CLIs.

Direct edits to mirror files are **not imported**. Agents use the Garnet library's MCP tools for document changes. Those tools read live content and require a matching content version before edits, preserving concurrent human work. Requests may target the current document, another document, or the library. Full-host agent actions outside the library remain ordinary host actions.

## Operations

```sh
./garnet logs
./garnet status
./garnet stop
./garnet start
./garnet update
```

`./garnet update` rebuilds and restarts the combined app service. `stop` stops the app and optional HTTPS service; MongoDB remains available for backups. Stop it explicitly with `systemctl --user stop garnet-mongo` when needed. Agent jobs are cancelled and their final events persisted during graceful app shutdown. Interrupted jobs are never automatically rerun.

A service-worker update activates once older app tabs close. Close and reopen existing tabs to load the latest UI. Keep all tabs on the same version when modifying the editor schema.

For a portable backup, stop Garnet and run `mongodump --uri mongodb://127.0.0.1:27018/ed --archive=backup.archive.gz --gzip`, then copy `data/documents` and `data/caddy-host`. For a raw file backup, also stop MongoDB before copying its data directory. Keep the Caddy CA to preserve device trust. Database state regenerates Markdown mirrors at startup.

Health is available at `/api/health`. Settings shows the integrated executor's host account; the UI reports storage and mirror failures.

## Development and verification

```sh
npm ci
npm run check
npm test
npm run build
npm run test:e2e
```

Browser tests require the host MongoDB service on port 27018. The suite automatically resets **only `ed_test`**, starts its own integrated server on port 8081 using `data/test-*`, and stops it afterward. Production `ed` is untouched. Recovery tests stop and restart this host test process.

For real CLI integration checks after the browser suite:

```sh
node scripts/test-app.mjs start
node scripts/smoke-agents.mjs
node scripts/test-app.mjs stop
```

These checks use your existing Claude/Codex accounts to create, read, edit, resume, and cancel jobs against the test library. Unit tests cover agent output, failed launches, cancellation, shutdown, and timeout without calling external agents.

`build/bundle-sizes.json` records gzip sizes. Browser traces and screenshots are written to `test-results/`. The browser suite also covers concurrent editors, offline reload/reconnection, cursor restoration, access restrictions, Markdown export, trash/restore, failed mirror writes, stale restore rejection, duplicate requests, and simulated storage quota failure.

Measured previously on this host with Chromium 153 and 500 documents of 19,390 bytes each: p95 cached open **47.3 ms**, typing-to-next-frame **11.8 ms**, and local search **55.9 ms**. Raw samples are in `verification/benchmark.json`; these are local measurements, not guarantees for every device.
