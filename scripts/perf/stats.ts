export const quantile = (values: number[], q: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b); const at = (sorted.length - 1) * q;
  const low = Math.floor(at); const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
};
export const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
export function summary(values: number[]) {
  const round = (v: number) => Number(v.toFixed(2));
  return { n: values.length, median: round(quantile(values, 0.5)), p95: round(quantile(values, 0.95)), mean: round(mean(values)), max: round(Math.max(...values)) };
}

// Two-sided Mann–Whitney U test (normal approximation with tie correction).
// It asks whether one build's samples tend to be larger than the other's,
// without assuming timings are normally distributed.
export function mannWhitney(a: number[], b: number[]) {
  const all = [...a.map(v => ({ v, g: 0 })), ...b.map(v => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array<number>(all.length); let ties = 0;
  for (let i = 0; i < all.length;) {
    let j = i; while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const rank = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[k] = rank;
    const t = j - i + 1; ties += t ** 3 - t; i = j + 1;
  }
  const n1 = a.length; const n2 = b.length; const n = n1 + n2;
  const r1 = all.reduce((sum, item, i) => sum + (item.g === 0 ? ranks[i] : 0), 0);
  const u = r1 - n1 * (n1 + 1) / 2;
  const sigma = Math.sqrt(n1 * n2 / 12 * ((n + 1) - ties / (n * (n - 1))));
  if (!sigma) return 1;
  const z = (Math.abs(u - n1 * n2 / 2) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - normalCdf(z)));
}
function normalCdf(z: number) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
