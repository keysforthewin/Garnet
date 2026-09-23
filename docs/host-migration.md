# Moving an existing installation to the host

Garnet now runs its server and agent executor in one user service. MongoDB 8+ runs natively or in the only application container. Garnet serves HTTP; external Cloudflare Tunnel handles public HTTPS. Existing accounts, notes, revisions, preferences, agent sessions, and browser origins are preserved by restoring the database and keeping the same public address.

1. Before removing the old deployment, save its Compose file for rollback. Stop the old app and runner so writes and agent jobs have finished. Leave the old database available for a logical backup.
2. Export the `ed` database with `mongodump --db ed --archive --gzip` from the old Mongo service into a private backup file. Export any demo/test databases you want to retain separately. Do not open Mongo 8 data files with an older host Mongo version.
3. Install MongoDB 8+ and Node 22.12+ on the host. Use a fresh `data/mongo-host` directory and bind MongoDB to `127.0.0.1:27018`. Restore the archive using `mongorestore --uri mongodb://127.0.0.1:27018 --archive=BACKUP --gzip`. Verify document/account counts before starting Garnet. Never point this restore at another application's database.
4. Keep `data/documents` and `data/runtime`.
5. Stop the old app and Mongo services and disable their restart policies. Preserve their original data directories and backup until the new setup is verified. Do not stop unrelated applications' containers or uninstall a shared container engine.
6. Run `./garnet build` and `./garnet install`. The installer disables legacy `garnet-runner` and `ed-runner` user services. Run `./garnet url` to find the chosen HTTP address, update your Cloudflare route to it, and verify the public HTTPS URL and document/agent access. The installer chooses free ports when its preferred ports are taken. Close old tabs and reopen them to load the new frontend.

Rollback requires stopping the new services before restarting the old ones. If the host app has accepted new writes, take a fresh database backup and restore it to the old deployment before rollback so those writes are retained.
