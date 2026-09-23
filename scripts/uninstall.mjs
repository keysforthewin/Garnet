import { readFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { readConfig } from './install-lib.mjs';

export async function uninstall(base) {
  base = await realpath(base);
  const home = await realpath(os.homedir());
  if (base === home || home.startsWith(`${base}/`) || base === '/' || !existsSync(path.join(base, 'releases'))) throw Error('Refusing to remove an unsafe installation directory.');
  const config = await readConfig(base);
  const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
  const inspect = (engine, type, name) => {
    try { return JSON.parse(execFileSync(engine, [type, 'inspect', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]; }
    catch (error) { if (/no such|not found|does not exist/i.test(String(error.stderr))) return null; throw error; }
  };
  const db = config.database;
  // Validate ownership before stopping services or deleting anything.
  let container, volume;
  if (db.kind === 'container') {
    container = inspect(db.engine, 'container', db.container);
    volume = inspect(db.engine, 'volume', db.volume);
    if (container && (container.Config.Labels?.app !== 'garnet' || !container.Mounts?.some(m => m.Name === db.volume && m.Destination === '/data/db'))) throw Error('Database container ownership could not be verified. Nothing removed.');
    if (volume && volume.Labels?.app !== 'garnet') throw Error('Database volume ownership could not be verified. Nothing removed.');
  }
  const units = path.join(home, '.config/systemd/user');
  const names = ['garnet-update.timer', 'garnet-update.service', 'garnet.service'];
  if (db.kind === 'container') names.push('garnet-mongo.service');
  for (const name of names) {
    const file = path.join(units, name);
    if (!existsSync(file)) continue;
    const text = await readFile(file, 'utf8');
    if (name !== 'garnet-update.timer' && !text.includes(base) && !(name === 'garnet-mongo.service' && text.includes(db.container))) throw Error(`Unrecognized service ${name}; refusing removal.`);
  }
  for (const name of names) {
    const file = path.join(units, name);
    if (!existsSync(file)) continue;
    // The update service only runs from its timer, so it has nothing to disable.
    run('systemctl', name === 'garnet-update.service' ? ['--user', 'stop', name] : ['--user', 'disable', '--now', name]);
    await rm(file);
  }
  run('systemctl', ['--user', 'daemon-reload']);
  if (container) run(db.engine, ['rm', '--force', '--volumes', db.container]);
  if (volume) run(db.engine, ['volume', 'rm', db.volume]);
  if (db.imageOwned) {
    // Never force removal: an image reused by another container must survive.
    try { run(db.engine, ['image', 'rm', db.image]); } catch { console.log('Keeping a database image still used by another container.'); }
  }
  const launcher = path.join(home, '.local/bin/garnet');
  if (existsSync(launcher)) {
    if (!(await readFile(launcher, 'utf8')).includes(base)) throw Error('The garnet command belongs to another installation; keeping it.');
    await rm(launcher);
  }
  await rm(base, { recursive: true, force: true });
  console.log('Garnet uninstalled: app, releases, private runtime, managed database, and services removed.');
  if (db.kind === 'host') console.log('Existing host MongoDB and its data were preserved.');
  if (!path.resolve(config.data).startsWith(`${base}/`)) console.log(`Previously adopted data preserved at ${config.data}.`);
  console.log('Your PATH and shared system tools were preserved.');
}
