import { existsSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Migration only. Never stop a shared proxy, uninstall Caddy, or touch tunnel services.
export async function retireHttps(compatibility = false) {
  const file = path.join(os.homedir(), '.config/systemd/user/garnet-https.service');
  if (!existsSync(file)) return;
  const ctl = (...args) => execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' });
  ctl('disable', '--now', 'garnet-https.service');
  if (compatibility) {
    // The v0.1 updater restarts this name after activating a release. Let that
    // in-flight updater finish without bringing back a TLS listener. The next
    // start/install/update removes this disabled, inert compatibility unit.
    await writeFile(file, '[Unit]\nDescription=Retired HTTPS compatibility placeholder\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/true\n');
  } else await rm(file);
  ctl('daemon-reload');
}
