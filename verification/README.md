# Verification

Garnet rename and deployment: verified default port 7777, public HTTPS at `garnet.outdoordevs.com`, branded login/sidebar/empty state and manifest, and the collaboration WebSocket upgrade through Cloudflare. The previous cabinet DNS record and ingress rule were replaced. Existing database and browser-storage identifiers were preserved for compatibility.

Verified on 2026-09-22 on the development Linux host.

- Dockerized build: passed, including TypeScript checking and six core tests.
- Five Playwright scenarios passed against a separate Mongo database: forced password change; three-client collaboration with cursor restoration and offline reload/merge; account restrictions/export/trash/settings; server outage and mirror-write recovery with conflict/idempotency checks; injected local-storage quota failure with in-memory export.
- Real Claude and Codex CLI smoke tests passed: create/read a document, resume the same session, and apply a document edit. Cancellation also passed.
- A browser-triggered Claude job read the active document through MCP and returned `PANEL VERIFIED` in the AI side panel.
- Multi-file Markdown import passed, with both contents verified in Mongo through the document API.
- Local HTTPS served the app successfully, and the certificate download service returned a valid PEM certificate. Device trust remains a setup step.
- The production library was left empty, with the seeded admin account still requiring its first password change.

`benchmark.json` contains the 500-document timing samples. `ai-panel.png` shows the tested AI panel. Browser traces and additional screenshots are generated under the ignored `test-results/` directory.

Scope of measurements: Chromium 153 on this host, with approximately 19 KB of Markdown per benchmark document. The quota scenario injects an IndexedDB quota error; it does not claim to reproduce every browser's storage eviction policy. Offline merging is tested in browsers; full-host CLI actions cannot be rolled back by restoring document revisions.
