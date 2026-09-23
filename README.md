# Garnet

Shared notes with local autosave, live collaboration, and optional Claude/Codex agents. Free, open source, [MIT licensed](LICENSE).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/keysforthewin/Garnet/main/install.sh | bash
```

Open the **local URL printed by the installer** (normally `http://127.0.0.1:7777`). Sign in with **admin / password**, then choose a new password. Busy ports are handled automatically.

The installer handles dependencies, starts the app in the background, enables startup after reboot—even before login—and checks daily for stable app releases. It uses your running MongoDB server when available; otherwise it sets up a database container. It may request your sudo password during setup.

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

## Cloudflare Tunnel: public HTTPS

Garnet serves **HTTP only** on loopback. Cloudflare supplies the public HTTPS certificate and encrypted tunnel. Run `cloudflared` directly on the **same machine** as Garnet; the only optional application container is MongoDB.

### 1. Find your local app address

Install Garnet, change the initial password, then run:

```sh
~/.local/bin/garnet url
```

Copy the printed address, for example `http://127.0.0.1:7778`. Use the actual port it prints throughout the tunnel setup. Check that the app is healthy:

```sh
curl "$(~/.local/bin/garnet url)/api/health"
```

The response should be `{"ok":true}`.

### 2. Create a tunnel, or select your existing one

You need a Cloudflare account and a domain managed by Cloudflare.

In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Networking → Tunnels**. For a new tunnel, choose **Create Tunnel**, name it, then select your Linux distribution and CPU architecture under **Setup Environment**. Run the dashboard's **Install and Run** commands on the Garnet machine. These install the native `cloudflared` connector and its background service. The service command has this form:

```sh
sudo cloudflared service install <TUNNEL_TOKEN>
```

Use the private token from your dashboard. Wait for the tunnel to show **Healthy**. If a dashboard-managed tunnel is already running on this machine, select it and continue below; skip installing another connector. These steps follow [Cloudflare's current setup guide](https://developers.cloudflare.com/tunnel/get-started/).

### 3. Connect a public hostname to Garnet

In your tunnel, open **Routes → Add route → Published application**:

| Field | Value |
| --- | --- |
| Hostname | Your subdomain and domain, for example `notes.example.com` |
| Service URL | The exact **HTTP** address from `garnet url`, for example `http://127.0.0.1:7778` |

If your dashboard separates the service fields, choose **HTTP** as the type and enter `127.0.0.1:7778` as the address. Save the route. Open **https://notes.example.com** in your browser.

HTTPS is now handled outside Garnet. The browser uses HTTPS to Cloudflare, and the connector forwards to Garnet over local HTTP. You do not need an application certificate, HTTPS port, SSL setting, or router port forwarding. Publish only the app's HTTP address; MongoDB stays private.

### Existing tunnel configured with a YAML file

For a locally managed tunnel, add this entry to its existing `ingress` list, **before the final catch-all rule**, using your actual hostname and app port:

```yaml
ingress:
  - hostname: notes.example.com
    service: http://127.0.0.1:7778
  # Keep any other application routes here.
  - service: http_status:404
```

Keep the existing tunnel ID, credentials file, and other routes. Add the hostname's DNS route with `cloudflared tunnel route dns <TUNNEL_NAME_OR_ID> notes.example.com`, then restart the service running that configuration (usually `sudo systemctl restart cloudflared`). See [Cloudflare's configuration reference](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/) and [tunnel routing](https://developers.cloudflare.com/tunnel/concepts/routing/).

### If the public URL does not work

First check the local health command above. Then check that the tunnel is **Healthy**, its hostname matches, and its Service URL uses **HTTP** with the port currently shown by `garnet url`. A **502** usually means the connector cannot reach that local address. After changing the app port, update this one route; your public hostname can stay the same.

Use a named tunnel for normal use. Cloudflare's temporary Quick Tunnels do not support server-sent events, which Garnet uses for live updates. See [Cloudflare's Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/#quick-tunnels-development).

## Ports and choosing a different port

The app needs **at most two local TCP listening ports**:

| Service | Preferred port | Behavior |
| --- | --- | --- |
| App, collaboration, and agents | `127.0.0.1:7777` | One HTTP listener; uses the next available port if busy |
| Managed MongoDB | `127.0.0.1:27018` | Uses the next available port at installation if busy; existing host databases retain their own address |

There is no HTTPS listener, SSL container, or separate agent-runner port. Agent document tools use a local Unix socket. Cloudflare's connector is external to the app and needs its own outbound network connectivity.

The installer prints the selected address. `~/.local/bin/garnet url` prints it again; `~/.local/bin/garnet status` also shows the database address. Ports are saved across restarts. If another process takes the app port before startup, Garnet binds the next available port, saves it, and reports it in the logs and `garnet url`.

To prefer a different HTTP port during installation:

```sh
curl -fsSL https://raw.githubusercontent.com/keysforthewin/Garnet/main/install.sh | bash -s -- --port=8888
```

To change it after installation:

```sh
~/.local/bin/garnet port 8888
~/.local/bin/garnet url
```

These commands also fall back automatically if the requested port is busy. Use a port between 1024 and 65535, then point your tunnel route to the URL printed by the command. For a source checkout, use `./garnet install --port=8888`; for foreground use, `./garnet run --port 8888`.

## Prerequisites and installation choices

- Linux with systemd and a regular user login session, Bash, curl, and internet access.
- A compatible x86-64 or ARM64 CPU. MongoDB 8 requires AVX on x86-64 and ARMv8.2-A or later on ARM64; see [MongoDB's platform requirements](https://www.mongodb.com/docs/manual/administration/production-notes/).
- Sudo access when dependencies or startup configuration need it. Run the installer as your regular account, **without** prefixing the command with sudo.
- Dependency installation paths are provided for `apt`, `dnf`, `pacman`, and `zypper`. Other distributions need their dependencies installed manually. These paths still need clean-machine verification across distributions; they are not a claim of universal Linux support.

You do not need to install Node or MongoDB first. The installer reuses compatible Node 22.12+/24 installations or downloads a private Node 24 LTS runtime. For containers, it reuses accessible Podman or Docker; otherwise it installs rootless Podman. Linux must support user namespaces for that fallback.

### Database choice

The default is automatic: preserve an existing installation, reuse a compatible local MongoDB 8+ server, or create a container. A reused host server must already be configured to start at boot. New connections to an existing server use a separate `garnet` database; existing Garnet installations keep their original database and data paths.

To choose explicitly, append installer options:

```sh
# Always use a new managed container.
curl -fsSL https://raw.githubusercontent.com/keysforthewin/Garnet/main/install.sh | bash -s -- --database=container

# Connect to a host database; include credentials in the URI if required.
curl -fsSL https://raw.githubusercontent.com/keysforthewin/Garnet/main/install.sh | bash -s -- --database=host --mongo-uri='mongodb://127.0.0.1:27017/garnet'
```

Connection settings are stored in a private file, not in service units. Reinstalling preserves the selected database. Switching backends requires an explicit data migration. The managed container publishes only on loopback, using its selected port (normally `127.0.0.1:27018`) and keeps data in the `garnet-mongo` volume. App updates never replace that volume or upgrade MongoDB's major version.

### Source installation

For development, install Node 22.12+ and MongoDB 8+, then run from a clone:

```sh
./garnet build && ./garnet install
```

This uses the existing host MongoDB binary and source-checkout services. It does not enable packaged automatic updates. To start these services before login, run `loginctl enable-linger "$USER"` once. Source updates use `./garnet update` after pulling changes.

For foreground use, start MongoDB and run `./garnet run`. Server options are `--host` (default `127.0.0.1`), `--port` (7777), `--mongo` (`mongodb://127.0.0.1:27018/ed`), `--storage`, `--runtime`, and `--public`. Managed installations pass the database connection through `GARNET_MONGO_URI`. `./ed` remains an alias for `./garnet`.

Existing installations should read [host migration](docs/host-migration.md) before changing database backends. The packaged installer can adopt the standard native source installation while retaining its data paths; custom service configurations require manual migration.

## Agents

Garnet runs the web server and agent executor in **one Node process**, managed by the `garnet.service` user service. Claude and Codex run as short-lived subprocesses for model discovery and agent jobs, using your existing host CLI logins. There is no separate runner to start. Settings → Agents controls executable paths, separate Claude/Codex model choices, working directory, and timeout. Model lists come from the installed CLIs at startup and refresh when an executable or working directory changes. Each selector also supports the CLI default and a custom model. Discovery only initializes the CLI and requests its catalog; it sends no prompt. Codex uses its [model/list interface](https://learn.chatgpt.com/docs/app-server#list-models-modellist); Claude returns models during its CLI initialization handshake. In the Ask your agent panel, the Model selector overrides the configured default for your next message and remembers that choice when you return to the conversation. Select New conversation to start a fresh chat. Starting context lists the current document once, followed by the library and other documents. Each signed-in user can invoke agents with the host account's full access.

## Offline use

Use the local loopback URL or your HTTPS Cloudflare hostname for browser offline support. Changing the hostname or local port creates a different browser origin, with its own login and offline cache.

The whole text library downloads in the background. After the application has loaded and caching finishes, you can reopen it offline, edit existing documents, and create new ones. Browser storage quotas and eviction policies still apply; use “Keep offline storage” and periodic exports. Agent jobs and shared settings require a server connection. Offline AI prompts remain drafts.

## Editing

- One click opens a document at your saved selection and scroll position.
- `Ctrl/Cmd+K` focuses library search; `Alt+N` creates a note; `Ctrl/Cmd+J` opens AI; `Ctrl/Cmd+\` opens or closes navigation.
- Formatting supports headings, emphasis, links, lists, checkboxes, quotes, code blocks, and simple tables. Markdown is the import/export format; whitespace and formatting syntax are normalized.
- Changes display immediately and save locally before syncing in the background. Document actions, including Export, are in the top-left menu.
- Changed content saves after 750 ms idle, at least every 5 seconds during continuous typing. Unchanged content does not create a version, change the saved timestamp, or rewrite its Markdown mirror. Collaboration state remains durable.
- Version previews compare each saved version with its predecessor: green additions, red removals, and yellow changed passages. Old duplicate snapshots are omitted from the list without deleting history.
- Pin documents from the pin icon beside each sidebar row. The menu combines document search and the document list with New document (Alt+N), Export, Version history, and Settings. Move to trash is in its own bottom section. Trash restores are shared actions.
- Export downloads current local content, including pending edits. Library ZIP export runs locally.

Mongo holds binary Yjs state, metadata, revisions, accounts, sessions, settings, preferences, and agent conversations. Plain Markdown is an asynchronous projection; it is not sufficient to recreate collaboration history or accounts.

## Files and data

Packaged installations live in `~/.local/share/garnet/`:

| Path | Purpose |
| --- | --- |
| `current` / `releases/` | Active and retained application releases |
| `install.json` | Private connection settings, runtime paths, and update preference |
| `data/documents/` | Markdown mirrors |
| `data/runtime/` | Document-tool socket and actual HTTP address in `listen.json` |
| Container volume `garnet-mongo` | Database for managed container installations |

A reused host MongoDB keeps its own storage. Adopted source installations keep their original `data/` paths. Source builds live in `build/`, with native MongoDB data in `data/mongo-host/`.

Builds and runtime use the host Node installation and npm dependencies. `./garnet build` installs dependencies, checks TypeScript, runs unit tests, and builds the app. The agent executor is included in `build/server.mjs`; `build/tools.mjs` is the short-lived MCP adapter launched by agent CLIs.

Direct edits to mirror files are **not imported**. Agents use the Garnet library's MCP tools for document changes. Those tools read live content and require a matching content version before edits, preserving concurrent human work. Requests may target the current document, another document, or the library. Full-host agent actions outside the library remain ordinary host actions.

## Updates and operations

The installer adds `~/.local/bin/garnet`. If that directory is on your PATH, you can shorten these commands to `garnet`:

```sh
~/.local/bin/garnet url
~/.local/bin/garnet status
~/.local/bin/garnet logs
~/.local/bin/garnet stop
~/.local/bin/garnet start
~/.local/bin/garnet update
~/.local/bin/garnet autoupdate status
~/.local/bin/garnet autoupdate off
~/.local/bin/garnet autoupdate on
```

Upgrading an older installation disables its built-in HTTPS service. Use a Cloudflare HTTP route to the address from `garnet url` for public access. Existing notes and database storage remain intact.

Automatic updates check daily, with up to an hour of randomized delay, and catch up after the machine has been off. Only published stable releases are installed. Downloads and dependencies are prepared before restarting the app. A failed health check restores the previous app release; this is an app rollback, not a database rollback. Update logs are available with `journalctl --user -u garnet-update.service`.

The database image is pinned when installed. Database, private Node runtime, container runtime, and operating-system upgrades remain separate maintenance tasks. Host Node installations follow their existing maintenance process.

`stop` leaves the database available for backups; stop `garnet-mongo.service` explicitly when needed for a managed database. Agent jobs are cancelled and their final events persisted during graceful shutdown. Interrupted jobs are never automatically rerun. Automatic updates can briefly interrupt editing connections and running agent jobs.

A service-worker update activates once older app tabs close. Close and reopen existing tabs to load the latest UI. Keep all tabs on the same version when modifying the editor schema.

For a portable backup, stop the app and use `mongodump` against the configured database, then copy the Markdown mirrors and private `install.json` file. With a managed container, use its runtime (`podman` or `docker`):

```sh
podman exec garnet-mongo mongodump --db ed --archive --gzip > backup.archive.gz
```

For native source installations, use `mongodump --uri mongodb://127.0.0.1:27018/ed --archive=backup.archive.gz --gzip`. Other host installations use their configured URI/database. Database tools may need a separate installation on native hosts. For raw file or volume backups, stop MongoDB first. Database state regenerates Markdown mirrors at startup.

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


## Publishing a release

Push a stable version tag such as `v0.1.0`. The release workflow runs checks, unit and browser tests, builds the app, and publishes `garnet-linux.tar.gz` and `SHA256SUMS`. Clients install that release on their next daily check. Publish only database-compatible app changes: automatic rollback restores application files, not data. MongoDB upgrades or incompatible migrations require a separate migration procedure.

For a local packaging check after building:

```sh
node scripts/package-release.mjs v0.1.0
```

See [installer verification](docs/installer-verification.md) for isolated acceptance checks. Publishing a release is separate from editing or testing the repository.
