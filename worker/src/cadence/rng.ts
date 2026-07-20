// Small deterministic RNG (splitmix64-seeded xoshiro-style 32-bit generator)
// with the distribution helpers the cadence model needs. Not numerically
// identical to numpy's PCG64, but seeded and reproducible run-to-run.

const NORMAL_POOL_SIZE = 8192; // power of two so masking replaces modulo

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  private normalPool: Float64Array;

  constructor(seed: number) {
    // splitmix32 to spread the seed across state words
    let h = seed >>> 0;
    const next = () => {
      h = (h + 0x9e3779b9) >>> 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // Precompute a pool of iid standard normals (Box–Muller once); the hot
    // Monte Carlo loop then draws normals at uniform-draw cost. Sampling with
    // replacement from 8k iid normals is statistically indistinguishable for
    // this model's fidelity, and Workers' 10 ms CPU cap needs the speed.
    this.normalPool = new Float64Array(NORMAL_POOL_SIZE);
    for (let i = 0; i < NORMAL_POOL_SIZE; i += 2) {
      let u = 0;
      do {
        u = this.random();
      } while (u <= 1e-12);
      const v = this.random();
      const r = Math.sqrt(-2.0 * Math.log(u));
      const theta = 2.0 * Math.PI * v;
      this.normalPool[i] = r * Math.cos(theta);
      this.normalPool[i + 1] = r * Math.sin(theta);
    }
  }

  /** Uniform float in [0, 1). */
  random(): number {
    // xoshiro128**
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.random();
  }

  /** Integer in [lo, hi) — numpy rng.integers semantics. */
  integers(lo: number, hi: number): number {
    return lo + Math.floor(this.random() * (hi - lo));
  }

  /** Standard normal drawn from the precomputed pool (uniform-draw cost). */
  standardNormal(): number {
    // xoshiro128** step inlined for the index draw
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return this.normalPool[result & (NORMAL_POOL_SIZE - 1)];
  }

  normal(mean: number, std: number): number {
    return mean + std * this.standardNormal();
  }

  lognormal(mu: number, sigma: number): number {
    return Math.exp(mu + sigma * this.standardNormal());
  }

  exponential(mean: number): number {
    let u = this.random();
    if (u >= 1) u = 1 - 1e-12;
    return -mean * Math.log(1 - u);
  }

  choice<T>(arr: T[]): T {
    return arr[this.integers(0, arr.length)];
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

// ---------------------------------------------------------------------------

export function clip(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export type NumArray = number[] | Float64Array;

export function mean(arr: NumArray): number {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

export function std(arr: NumArray, ddof = 0): number {
  const n = arr.length;
  if (n <= ddof) return 0;
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < n; i++) s += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(s / (n - ddof));
}

/** numpy-style linear-interpolation quantile. `arr` need not be sorted. */
export function quantile(arr: NumArray, q: number): number {
  if (!arr.length) return 0;
  // Float64Array.sort() is numeric and comparator-free — much faster.
  const sorted = Float64Array.from(arr).sort();
  return quantileSorted(sorted, q);
}

export function quantileSorted(sorted: NumArray, q: number): number {
  const n = sorted.length;
  if (!n) return 0;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
