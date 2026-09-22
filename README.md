# Garnet

A small shared notes app: Tiptap editing, live cursors, offline documents, Mongo persistence, Markdown files on the host, and Claude/Codex CLI conversations.

Licensed under the [MIT License](LICENSE).

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
