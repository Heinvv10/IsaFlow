/**
 * Seeded PRNG (mulberry32) so the same date and seed always give the same data.
 * Money is handled in integer cents throughout the generator.
 */

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi], inclusive. */
export function between(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick from an empty list');
  return items[between(rng, 0, items.length - 1)]!;
}

/** A version-4 shaped uuid drawn from the PRNG (deterministic per seed). */
export function uuidFrom(rng: Rng): string {
  const hex: string[] = [];
  for (let i = 0; i < 32; i++) hex.push(between(rng, 0, 15).toString(16));
  hex[12] = '4';
  hex[16] = ((between(rng, 0, 15) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Cents to a 2-decimal string for numeric columns. */
export function money(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`money expects integer cents, got ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Rand amount (number, any precision) to integer cents, half away from zero. */
export function toCents(rand: number): number {
  return Math.sign(rand) * Math.round(Math.abs(rand) * 100 + 1e-9);
}

/** Round a rand amount to whole hundreds of rand, in cents (for tidy invoice values). */
export function roundCents(cents: number, step: number): number {
  return Math.round(cents / step) * step;
}
