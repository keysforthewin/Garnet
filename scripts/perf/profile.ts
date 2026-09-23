// Summarizes a .cpuprofile saved by `run.ts --profile`: the functions with the
// most self time, and the most inclusive time (each function counted once per
// sample). Profile an unminified build to get readable names.
//   npx tsx scripts/perf/profile.ts perf-results/after-typingLarge.cpuprofile [--top 25]
import { readFile } from 'node:fs/promises';

interface Node { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }
const file = process.argv[2]; const top = Number(process.argv[process.argv.indexOf('--top') + 1]) || 25;
if (!file) throw new Error('Usage: profile.ts <file.cpuprofile> [--top N]');
const profile: { nodes: Node[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number } = JSON.parse(await readFile(file, 'utf8'));
const byId = new Map(profile.nodes.map(node => [node.id, node])); const parent = new Map<number, number>();
for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
const label = ({ callFrame: f }: Node) => `${f.functionName || '(anonymous)'} ${f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : ''}`.trim();
const self = new Map<string, number>(); const total = new Map<string, number>(); let busy = 0;
profile.samples.forEach((id, i) => {
  const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000; const node = byId.get(id)!; const name = label(node);
  if (['(idle)', '(program)'].includes(node.callFrame.functionName)) { self.set(name, (self.get(name) || 0) + ms); return; }
  busy += ms; self.set(name, (self.get(name) || 0) + ms);
  const seen = new Set<string>();
  for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) { const key = label(byId.get(at)!); if (!seen.has(key)) { seen.add(key); total.set(key, (total.get(key) || 0) + ms); } }
});
const print = (title: string, map: Map<string, number>) => {
  console.log(`\n${title}`);
  for (const [name, ms] of [...map].filter(([name]) => !name.startsWith('(root)')).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${ms.toFixed(1).padStart(9)} ms ${(ms / busy * 100).toFixed(1).padStart(5)}%  ${name}`);
};
console.log(`${file}: ${((profile.endTime - profile.startTime) / 1000).toFixed(0)} ms recorded, ${busy.toFixed(0)} ms busy (excluding idle and program)`);
print('Self time', self); print('Inclusive time', total);
