#!/usr/bin/env node
import { installation, setup, doctor, remove, terminalPrompt } from './setup.mjs';
const [command = 'help', ...args] = process.argv.slice(2);
try {
  if (!['setup', 'doctor', 'remove'].includes(command)) {
    console.log('Usage: garnet-mcp setup|doctor|remove [--root=PATH] [--agents=claude,codex] [--replace]\nSetup asks before modifying each agent. --agents grants explicit consent for those agents. --replace also permits replacing a conflicting entry.');
    if (command !== 'help' && command !== '--help') process.exitCode = 1;
  } else {
    for (const arg of args) if (!/^--(root|agents)=.+$/.test(arg) && arg !== '--replace') throw Error(`Unknown option: ${arg}`);
    const root = args.find(a => a.startsWith('--root='))?.slice(7);
    const selected = args.find(a => a.startsWith('--agents='))?.slice(9).split(',');
    if (selected?.some(a => !['claude', 'codex', 'manual'].includes(a))) throw Error('Agents must be claude,codex,manual.');
    const target = await installation(root);
    if (command === 'doctor') await doctor(target);
    else if (command === 'remove') await remove(target, { agents: selected });
    else {
      const prompt = await terminalPrompt();
      try { await setup(target, { agents: selected, replace: args.includes('--replace'), ask: prompt.ask }); }
      finally { await prompt.close(); }
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
