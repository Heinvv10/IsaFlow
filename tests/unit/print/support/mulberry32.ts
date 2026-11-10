/**
 * A seeded generator of floats in [0, 1) whose state stays inside 32 bits (Math.imul), so every draw is distinct for
 * 2^32 draws. The LCG the print sets used (`s * 1103515245 + 12345` in doubles) passes 2^53 and loses its low bits: its
 * 1,500 "random" lines of `packLineFit.test.ts` were 627 distinct.
 */
export function* mulberry32(seed: number): Generator<number> {
  let a = seed >>> 0;
  for (;;) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    yield ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
