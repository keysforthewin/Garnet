// Compares two harness results. Every metric is "lower is better".
//   npx tsx scripts/perf/compare.ts perf-results/before.json perf-results/after.json [--markdown]
import { readFile } from 'node:fs/promises';
import { mannWhitney, quantile } from './stats';

const args = process.argv.slice(2); const markdown = args.includes('--markdown');
const [beforePath, afterPath] = args.filter(a => !a.startsWith('--'));
if (!beforePath || !afterPath) throw new Error('Usage: compare.ts <before.json> <after.json> [--markdown]');
const before = JSON.parse(await readFile(beforePath, 'utf8')); const after = JSON.parse(await readFile(afterPath, 'utf8'));
if (before.cpuSlowdown !== after.cpuSlowdown || before.documents !== after.documents) console.warn('Warning: the runs used different CPU slowdown or library sizes.');

const format = (v: number) => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
const rows: string[][] = [];
for (const scenario of Object.keys({ ...before.samples, ...after.samples })) {
  for (const metric of Object.keys({ ...before.samples[scenario], ...after.samples[scenario] })) {
    const a: number[] = before.samples[scenario]?.[metric] || []; const b: number[] = after.samples[scenario]?.[metric] || [];
    if (!a.length || !b.length) { rows.push([scenario, metric, a.length ? format(quantile(a, 0.5)) : '—', b.length ? format(quantile(b, 0.5)) : '—', '', '', '', '', 'n/a']); continue; }
    const medianA = quantile(a, 0.5); const medianB = quantile(b, 0.5);
    const change = medianA === 0 ? (medianB === 0 ? 0 : Infinity) : (medianB - medianA) / medianA * 100;
    // With fewer than four samples per side a rank test cannot reach p < 0.05.
    const p = a.length >= 4 && b.length >= 4 ? mannWhitney(a, b) : NaN;
    const meaningful = Math.abs(change) >= 5;
    const verdict = Number.isNaN(p) ? (meaningful ? (change < 0 ? 'better (few samples)' : 'worse (few samples)') : 'same') : p < 0.05 && meaningful ? (change < 0 ? 'BETTER' : 'WORSE') : 'no clear change';
    rows.push([scenario, metric, format(medianA), format(medianB), `${change > 0 ? '+' : ''}${Number.isFinite(change) ? change.toFixed(0) : '∞'}%`, format(quantile(a, 0.95)), format(quantile(b, 0.95)), Number.isNaN(p) ? '' : p < 0.001 ? '<0.001' : p.toFixed(3), verdict]);
  }
}
const header = ['scenario', 'metric', `${before.label} median`, `${after.label} median`, 'Δ median', `${before.label} p95`, `${after.label} p95`, 'p', 'verdict'];
if (markdown) {
  console.log(`| ${header.join(' | ')} |\n|${header.map(() => ' --- ').join('|')}|`);
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
} else {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join('  ');
  console.log(line(header)); console.log(widths.map(w => '-'.repeat(w)).join('  '));
  let last = ''; for (const row of rows) { if (row[0] !== last && last) console.log(''); last = row[0]; console.log(line(row)); }
}
console.log(`\n${before.label}: ${before.commit} ${before.date}\n${after.label}: ${after.commit} ${after.date}\nCPU slowdown ${after.cpuSlowdown}x, ${after.documents} documents. p = two-sided Mann–Whitney U; BETTER/WORSE needs p < 0.05 and a median change of at least 5%.`);
