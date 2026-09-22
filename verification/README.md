# Verification

Verified on 2026-09-22 on the development Linux host.

The live deployment runs directly on the host. `garnet.service` contains the HTTP server and agent executor in one Node process. `garnet-mongo.service` runs MongoDB 8 on loopback port 27018; `garnet-https.service` supplies direct LAN HTTPS on port 8443. Garnet's old containers, networks, and standalone runner service have been removed. Other applications' services are unchanged.

- TypeScript checking, the host production build, and 16 core/agent/history/model tests passed.
- All eight Playwright scenarios passed using an automatically managed host test server and separate `ed_test` database: bootstrap password change, three-client collaboration and offline reload/merge, access restrictions/export/trash/settings, server outage and mirror recovery, and injected local-storage quota failure.
- Real Claude and Codex checks passed through the integrated server: document creation/read/edit, session continuation, and cancellation against the isolated test library.
- Integrated executor unit tests cover ordered streaming/session events, failed CLI startup, temporary config cleanup, cancellation, shutdown, and timeout.
- Added coverage verifies sidebar pinning, content-only history, unchanged revision counts/timestamps/mirror files after idle and no-op saves, colored previews/restoration, and separate model settings with executable discovery failures.
- Live discovery returned model catalogs from both installed CLIs without submitting a prompt.
- Select spacing was checked in Settings and all three AI dropdowns on desktop and mobile. Screenshots are in the ignored `test-results/host-select-*.png` files.
- Both `https://garnet.outdoordevs.com/api/health` and direct `https://localhost:8443/api/health` passed; direct HTTPS was verified against the preserved CA.
- Restored production collection counts matched the pre-migration backup. The original CA certificate is byte-for-byte unchanged.

The private migration archive, original Compose configuration, original runner unit, and production collection counts are in `data/deployment-backups/host-migration/`. Original database and certificate directories are retained for rollback; the active services use `data/mongo-host/` and `data/caddy-host/`.

Use `./garnet status`, `./garnet logs`, `./garnet stop`, `./garnet start`, and `./garnet update` for operations. See the main README for host prerequisites, backups, browser tests, and real-agent smoke checks. Close existing app tabs and reopen them to activate the updated service worker.

Historical performance measurements remain in `benchmark.json`: Chromium 153 on this host with 500 documents of approximately 19 KB each. These measurements predate the host migration and are not a new benchmark. The quota test injects a storage error; it does not reproduce every browser's eviction behavior.
