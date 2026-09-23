import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function setupPath({ home = os.homedir(), shell = process.env.SHELL || '/bin/bash', zdotdir = process.env.ZDOTDIR, envPath = process.env.PATH || '' } = {}) {
  const bin = path.join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  const kind = path.basename(shell);
  const zhome = zdotdir || home;
  const candidates = kind === 'zsh' ? [path.join(zhome, '.zshrc'), path.join(zhome, '.zprofile'), path.join(zhome, '.zshenv')]
    : kind === 'fish' ? [path.join(home, '.config/fish/config.fish')]
    : [path.join(home, '.bashrc'), path.join(home, '.bash_profile'), path.join(home, '.profile')];
  const files = await Promise.all(candidates.map(async file => ({ file, text: await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) })));
  const assignment = /^\s*(?:export\s+)?PATH=|^\s*(?:typeset\s+-[a-zA-Z]+\s+)?path=|^\s*(?:fish_add_path|set\s+.*PATH)/;
  const active = text => text.split('\n').filter(line => assignment.test(line) || line.startsWith('case ":$PATH:"') || line.startsWith('(( ${path['));
  const already = files.find(item => active(item.text).some(line => [bin, '$HOME/.local/bin', '${HOME}/.local/bin', '~/.local/bin'].some(value => line.includes(value))));
  let changed = false;
  const chosen = already || files.find(item => active(item.text).length) || files[0];
  if (!already) {
    const lines = chosen.text.split('\n');
    // Reuse a complete, single-line PATH assignment's location and shell syntax.
    let index = lines.findLastIndex(line => assignment.test(line) && !line.trimEnd().endsWith('\\') && (!line.includes('path=(') || line.includes(')')));
    const arrayStyle = index >= 0 && /^\s*path=/.test(lines[index]);
    const addition = kind === 'fish' ? 'fish_add_path --path "$HOME/.local/bin"'
      : arrayStyle ? '(( ${path[(Ie)$HOME/.local/bin]} )) || path=("$HOME/.local/bin" $path)'
      : 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac';
    if (index < 0) index = lines.length - 1;
    lines.splice(index + 1, 0, addition);
    await mkdir(path.dirname(chosen.file), { recursive: true });
    await writeFile(chosen.file, lines.join('\n').replace(/\n?$/, '\n'));
    changed = true;
  }
  return { file: chosen.file, changed, active: envPath.split(path.delimiter).includes(bin), shell: kind };
}
