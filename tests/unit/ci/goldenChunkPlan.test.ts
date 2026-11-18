import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_FILE, CONTRAST_SECONDS, CONTRAST_TITLE_TAIL, FILE_SECONDS, SPEC_DIR, chunkSeconds, contrastSlugs, planChunk, planItems,
  splitItems, toInvocations, type Item,
} from '../../../scripts/ci/golden-hosted/goldenChunkPlan';

const ROOT = path.resolve(__dirname, '../../..');

/** The min-max over every contiguous split of `w` into `k` non-empty parts, by trying them all (small inputs only). */
function bruteMinMax(w: number[], k: number): number {
  if (k === 1) return w.reduce((a, b) => a + b, 0);
  let best = Infinity;
  for (let i = 1; i <= w.length - k + 1; i++) best = Math.min(best, Math.max(w.slice(0, i).reduce((a, b) => a + b, 0), bruteMinMax(w.slice(i), k - 1)));
  return best;
}
/** The same optimum by another route: the least cap (integer weights) that a greedy fill keeps to k parts. */
function optimalMax(w: number[], k: number): number {
  const parts = (cap: number) => { let n = 1, run = 0; for (const x of w) { if (run + x > cap) { n += 1; run = 0; } run += x; } return n; };
  let lo = Math.max(...w), hi = w.reduce((a, b) => a + b, 0);
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (parts(mid) <= k) hi = mid; else lo = mid + 1; }
  return lo;
}
const DIR = path.join(ROOT, SPEC_DIR);
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.spec.ts'));
const CONTRAST_SRC = readFileSync(path.join(DIR, CONTRAST_FILE), 'utf8');
const N = 6;
/** What chunk k runs, as the set of "file" or "file#slug" units. */
function units(k: number): string[] {
  return planChunk(ROOT, k, N).items.map((i) => (i.kind === 'file' ? i.name : `${CONTRAST_FILE}#${i.name}`));
}

describe('golden chunk plan against the real specs', () => {
  it('runs every spec file and every contrast screen in exactly one chunk', () => {
    const all = Array.from({ length: N }, (_, i) => units(i + 1)).flat();
    const want = [...FILES.filter((f) => f !== CONTRAST_FILE), ...contrastSlugs(CONTRAST_SRC).map((s) => `${CONTRAST_FILE}#${s}`)];
    expect([...all].sort()).toEqual([...want].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('leaves no chunk empty and none over 12 minutes of measured test time', () => {
    const secs = Array.from({ length: N }, (_, i) => chunkSeconds(planChunk(ROOT, i + 1, N).items));
    expect(Math.min(...secs)).toBeGreaterThan(0);
    expect(Math.max(...secs)).toBeLessThan(12 * 60);
  });

  // What the splitter guarantees, not a ratio with thin headroom (that turned red in unrelated PRs as specs were added):
  // its longest chunk is the optimum (checked by an independent binary search), which is within total/N + the largest item.
  it.each([
    ['the suite as it is', () => ROOT],
    ['the suite plus one new default-weight spec (18 Nov: z30 beside z32 put the midpoint rule 54 s over the optimum; any new spec can shift a boundary)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'chunk-'));
      mkdirSync(path.join(tmp, SPEC_DIR), { recursive: true });
      for (const f of FILES) writeFileSync(path.join(tmp, SPEC_DIR, f), f === CONTRAST_FILE ? CONTRAST_SRC : '');
      writeFileSync(path.join(tmp, SPEC_DIR, 'zz-new-spec.spec.ts'), '');
      return tmp;
    }],
  ])('%s: the longest chunk is the optimum, within total/N + the largest item', (_name, root) => {
    const dir = root();
    const items = planItems(readdirSync(path.join(dir, SPEC_DIR)), CONTRAST_SRC);
    const secs = Array.from({ length: N }, (_, i) => chunkSeconds(planChunk(dir, i + 1, N).items));
    const weights = items.map((i) => i.seconds);
    expect(Math.max(...secs)).toBe(optimalMax(weights, N));
    expect(Math.max(...secs)).toBeLessThanOrEqual(weights.reduce((a, b) => a + b, 0) / N + Math.max(...weights));
  });

  it('keeps the suite order: a chunk is a run of the old single run', () => {
    const order = Array.from({ length: N }, (_, i) => units(i + 1)).flat().map((u) => u.split('#')[0]!);
    const dedup = order.filter((f, i) => order.indexOf(f) === i);
    expect(dedup).toEqual([...FILES].sort());
  });

  it('knows no file or screen that is gone (a stale weight hides a rename)', () => {
    expect(Object.keys(FILE_SECONDS).filter((f) => !FILES.includes(f))).toEqual([]);
    expect(Object.keys(CONTRAST_SECONDS).filter((s) => !contrastSlugs(CONTRAST_SRC).includes(s))).toEqual([]);
  });

  it('matches the contrast test titles the --grep is built on', () => {
    expect(CONTRAST_SRC).toContain('`${screen.slug}' + CONTRAST_TITLE_TAIL);
  });

  it('cannot name a file as a suffix of another (playwright file arguments are substring filters)', () => {
    for (const a of FILES) for (const b of FILES) if (a !== b) expect(`${SPEC_DIR}/${b}`.endsWith(`${SPEC_DIR}/${a}`)).toBe(false);
  });
});

describe('golden chunk plan pieces (a dev server per piece)', () => {
  const PIECES = 3;
  const piece = (k: number, p: number) => planChunk(ROOT, k, N, p, PIECES).items;

  it('cuts every chunk into pieces that together are exactly the chunk, in order, none empty', () => {
    for (let k = 1; k <= N; k++) {
      const parts = Array.from({ length: PIECES }, (_, i) => piece(k, i + 1));
      expect(parts.every((x) => x.length > 0)).toBe(true);
      expect(parts.flat()).toEqual(planChunk(ROOT, k, N).items);
    }
  });

  it('keeps every piece to about 3 minutes of measured test time (the dev server stays under its memory threshold)', () => {
    for (let k = 1; k <= N; k++) for (let p = 1; p <= PIECES; p++) expect(chunkSeconds(piece(k, p))).toBeLessThan(5 * 60);
  });

  it('refuses a piece outside 1..pieces', () => {
    expect(() => planChunk(ROOT, 1, N, 4, 3)).toThrow(/piece 4 is outside 1..3/);
    expect(() => planChunk(ROOT, 1, N, 0, 3)).toThrow(/outside/);
  });
});

describe('golden chunk plan mechanics', () => {
  const items = planItems(['b.spec.ts', 'a.spec.ts', 'readme.md', CONTRAST_FILE], "const SCREENS = [\n  { slug: 'x-1', path: '/x' },\n  { slug: 'y', path: '/y' },\n] as const;");

  it('orders by code point, drops non-specs and expands the contrast file per screen at its place', () => {
    expect(items.map((i) => i.name)).toEqual(['a.spec.ts', 'b.spec.ts', 'x-1', 'y']);
  });

  it('gives a file the table does not list the default weight, so a new spec still runs', () => {
    expect(items[0]).toMatchObject({ kind: 'file', seconds: 30 });
  });

  it('splits contiguously and loses nothing for any chunk count', () => {
    for (const n of [1, 2, 3, 5, 9]) {
      const parts = splitItems(items, n);
      expect(parts).toHaveLength(n);
      expect(parts.flat()).toEqual(items);
    }
  });

  it('makes the longest chunk as short as a contiguous split can (the midpoint rule left 80 / 150 / 110 here)', () => {
    const w = (seconds: number, i: number): Item => ({ kind: 'file', name: `s${i}.spec.ts`, seconds });
    const parts = splitItems([80, 90, 10, 30, 20, 40, 70].map(w), 3);
    expect(parts.map(chunkSeconds)).toEqual([80, 130, 130]);
    expect(parts.flat().map((i) => i.name)).toEqual(['s0.spec.ts', 's1.spec.ts', 's2.spec.ts', 's3.spec.ts', 's4.spec.ts', 's5.spec.ts', 's6.spec.ts']);
  });

  it('is optimal: on random small inputs the longest chunk equals a brute-force min-max over every contiguous split', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let t = 0; t < 400; t++) {
      const w = Array.from({ length: 1 + rnd(9) }, () => rnd(10) * 10);
      const k = 1 + rnd(5);
      const items = w.map((seconds, i): Item => ({ kind: 'file', name: `s${i}.spec.ts`, seconds }));
      const parts = splitItems(items, k);
      expect(parts.flat()).toEqual(items);
      if (w.length >= k) expect(parts.every((p) => p.length > 0)).toBe(true);
      expect(Math.max(...parts.map(chunkSeconds)), `${JSON.stringify(w)} in ${k}`).toBe(bruteMinMax(w, Math.min(k, w.length)));
    }
  });

  it('refuses a negative or non-finite weight', () => {
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => splitItems([{ kind: 'file', name: 'a.spec.ts', seconds }], 1)).toThrow(/impossible weight/);
    }
  });

  it('makes one invocation per run of the same kind, with the screens in a --grep', () => {
    const inv = toInvocations(items);
    expect(inv).toEqual([
      { files: [`${SPEC_DIR}/a.spec.ts`, `${SPEC_DIR}/b.spec.ts`] },
      { files: [`${SPEC_DIR}/${CONTRAST_FILE}`], grep: '\\s(?:x-1|y): AA contrast' },
    ]);
  });

  it('refuses a slug or file name with shell or regex characters', () => {
    expect(() => planItems(['a b.spec.ts'], CONTRAST_SRC)).toThrow(/unexpected name/);
    expect(() => contrastSlugs("const SCREENS = [\n { slug: 'a|b', path: '/' },\n] as const;")).toThrow(/unexpected name/);
  });

  it('refuses a chunk outside 1..n and a missing SCREENS list', () => {
    expect(() => planChunk(ROOT, 7, 6)).toThrow(/outside/);
    expect(() => planChunk(ROOT, 0, 6)).toThrow(/outside/);
    expect(() => contrastSlugs('nothing')).toThrow(/no SCREENS/);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'chunk-'));
    mkdirSync(path.join(tmp, SPEC_DIR), { recursive: true });
    writeFileSync(path.join(tmp, SPEC_DIR, CONTRAST_FILE), "const SCREENS = [\n  { slug: 'only', path: '/' },\n] as const;");
    writeFileSync(path.join(tmp, SPEC_DIR, 'a.spec.ts'), '');
    expect(planChunk(tmp, 1, 1).items.map((i) => i.name)).toEqual(['a.spec.ts', 'only']);
  });
});
