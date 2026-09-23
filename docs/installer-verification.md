# Installer verification

Run repository checks with `npm run check`, `npm test`, `npm run build`, and `npm run test:e2e`. Installer tests use temporary directories, fake restart/health callbacks, and a fail-closed host-command simulator; they never alter the host's systemd services or database. Process tests exercise service generation, native-install migration recovery, occupied ports, container selection, and repeat installation.

After building, run `node scripts/package-release.mjs v0.1.0`. Extract `build/release/garnet-linux.tar.gz` into a temporary directory, verify `SHA256SUMS`, and run `npm ci --omit=dev --ignore-scripts` there. The release must include the production build and management scripts, and exclude host data and credentials.

With Docker available, `node scripts/smoke-release.mjs` automates a production-archive check using disposable Node 24 and MongoDB containers on an isolated network. It checks health, frontend delivery, and the first login, then removes the containers and their storage. It does not test systemd or reboot behavior.

## Clean-machine acceptance

Use disposable **systemd VMs**, not the development machine. Cover Ubuntu/Debian (`apt`), Fedora (`dnf`), Arch (`pacman`), and openSUSE (`zypper`), plus ARM64 hardware/VMs with MongoDB-compatible CPU features. Package-manager support alone does not establish runtime compatibility.

Before the first release, copy an extracted release to `~/.local/share/garnet/releases/.stage.acceptance`, install its production dependencies, and write its stable version to `VERSION`. Run:

```sh
node ~/.local/share/garnet/releases/.stage.acceptance/scripts/manage.mjs install \
  --stage="$HOME/.local/share/garnet/releases/.stage.acceptance"
```

This tests service installation without publishing. After release publication, separately test the README's exact curl command from a VM without Node or a container runtime.

| Scenario | Required outcome |
| --- | --- |
| No MongoDB or runtime | Install rootless Podman, create a persistent database, serve localhost:7777 |
| Accessible Docker already installed | Reuse it without replacing the runtime |
| MongoDB 8+ running on 27017 | Reuse it with the dedicated `garnet` database |
| Authenticated host MongoDB | Explicit URI works; bad credentials fail without selecting another database |
| Existing standard source install | Keep its original database, Markdown, and accounts |
| Interrupted container creation | Rerun completes using its recorded volume without deleting notes |
| Uninstall | Removes managed resources, preserves shared host MongoDB and PATH |
| Repeated installation | Preserve selected backend, data, password and update preference |
| Occupied app/database ports | Choose available alternatives, persist them, and print the correct HTTP URL |
| Explicit HTTP port / later collision | Use the preference if available; otherwise choose and report a free port |
| Logout and reboot before login | App and managed database start and become healthy |
| Host database starts late | App retries until the database is ready |
| Container recreation with original volume | Notes and credentials survive |
| Daily timer / manual update | Only newer stable releases activate |
| Offline / interrupted / corrupt download | Running release stays unchanged |
| Failed new app health | Previous release restarts; data remains untouched |
| Concurrent installer/updater | Only the lock holder runs |
| Automatic updates disabled | Remain disabled across reinstall |

Inspect `systemctl --user status garnet.service garnet-mongo.service`, `loginctl show-user "$USER" -p Linger`, and `journalctl --user -u garnet-update.service`. Test a fresh login and note creation, then repeat after reboot and an update.

VM acceptance and public bootstrap verification must be recorded before claiming tested support for a distribution. Do not substitute a successful unit test or build for a reboot test.
