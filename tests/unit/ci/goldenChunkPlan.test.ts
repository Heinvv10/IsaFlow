import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_FILE, CONTRAST_SECONDS, CONTRAST_TITLE_TAIL, FILE_SECONDS, SPEC_DIR, SPLIT_BY_THEME, chunkSeconds, contrastSlugs, planChunk, planItems,
  splitItems, toInvocations, invocationArgs, type Item,
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
  return planChunk(ROOT, k, N).items.map((i) => (i.kind === 'file' ? i.name : i.kind === 'theme' ? `${i.file}#${i.name}` : `${CONTRAST_FILE}#${i.name}`));
}

describe('golden chunk plan against the real specs', () => {
  it('runs every spec file and every contrast screen in exactly one chunk', () => {
    const all = Array.from({ length: N }, (_, i) => units(i + 1)).flat();
    const split = Object.entries(SPLIT_BY_THEME).flatMap(([f, themes]) => Object.keys(themes).map((t) => `${f}#${t}`));
    const want = [...FILES.filter((f) => f !== CONTRAST_FILE && !(f in SPLIT_BY_THEME)), ...split, ...contrastSlugs(CONTRAST_SRC).map((s) => `${CONTRAST_FILE}#${s}`)];
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

describe('files cut per theme (z19-native-selects overran the dev server\'s memory threshold in one piece, #1847)', () => {
  const PLAYWRIGHT = path.join(ROOT, 'node_modules/.bin/playwright');
  const list = (file: string, grep?: string): string[] => {
    const r = spawnSync(PLAYWRIGHT, ['test', '--config', 'playwright-golden.config.ts', `${SPEC_DIR}/${file}`, ...(grep ? ['--grep', grep] : []), '--list'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split('\n').filter((l) => / › /.test(l)).map((l) => l.trim());
  };

  it('splits only files that exist, with positive weights, and each theme is a describe title in the spec', () => {
    for (const [file, themes] of Object.entries(SPLIT_BY_THEME)) {
      expect(FILES).toContain(file);
      expect(Object.keys(FILE_SECONDS)).not.toContain(file); // the themes carry the weight now
      expect(Object.values(themes).every((x) => x > 0)).toBe(true);
      const src = readFileSync(path.join(DIR, file), 'utf8');
      expect(src).toContain('test.describe(`${theme} theme`');
      expect(readFileSync(path.join(ROOT, 'tests/e2e/helpers/themeSpec.ts'), 'utf8')).toContain("THEMES = ['light', 'dark'] as const");
      expect(Object.keys(themes).sort()).toEqual(['dark', 'light']);
    }
  });

  it("the --grep of each theme selects exactly that theme's tests in Playwright's own listing, and the themes together are the whole file", () => {
    const { invocations } = planChunk(ROOT, 1, 1);
    for (const file of Object.keys(SPLIT_BY_THEME)) {
      const whole = list(file);
      const parts = invocations.filter((i) => i.files[0]!.endsWith(`/${file}`)).map((i) => list(file, i.grep));
      expect(parts).toHaveLength(Object.keys(SPLIT_BY_THEME[file]!).length);
      for (const [idx, theme] of Object.keys(SPLIT_BY_THEME[file]!).entries()) {
        expect(parts[idx]!.length, theme).toBeGreaterThan(0);
        expect(parts[idx]!.every((l) => l.includes(`› ${theme} theme ›`)), theme).toBe(true);
      }
      expect(parts.flat().sort()).toEqual([...whole].sort());
    }
  }, 120_000);

  it('turns a theme into its own invocation with a --grep, between the file runs around it', () => {
    const items: Item[] = [
      { kind: 'file', name: 'a.spec.ts', seconds: 5 },
      { kind: 'theme', name: 'light', file: 'z.spec.ts', seconds: 5 },
      { kind: 'theme', name: 'dark', file: 'z.spec.ts', seconds: 5 },
      { kind: 'file', name: 'b.spec.ts', seconds: 5 },
    ];
    expect(toInvocations(items)).toEqual([
      { files: [`${SPEC_DIR}/a.spec.ts`] },
      { files: [`${SPEC_DIR}/z.spec.ts`], grep: '\\slight theme\\s' },
      { files: [`${SPEC_DIR}/z.spec.ts`], grep: '\\sdark theme\\s' },
      { files: [`${SPEC_DIR}/b.spec.ts`] },
    ]);
  });

  it('never puts two themes of one file in the same piece, in any chunk, so each theme gets a fresh dev server', () => {
    for (let k = 1; k <= N; k++) {
      const holders = new Map<string, number[]>();
      for (let p = 1; p <= 3; p++) for (const i of planChunk(ROOT, k, N, p, 3).items) if (i.kind === 'theme') holders.set(i.file, [...(holders.get(i.file) ?? []), p]);
      for (const [file, ps] of holders) expect(new Set(ps).size, `${file} in chunk ${k}: pieces ${ps}`).toBe(ps.length);
    }
  });

  const th = (file: string, name: string, seconds: number): Item => ({ kind: 'theme', name, file, seconds });
  const fi = (name: string, seconds: number): Item => ({ kind: 'file', name, seconds });

  it('keeps two themes of a file apart even when sharing a piece would be cheaper (the unconstrained optimum is 222 / 212 / 180)', () => {
    const items = [fi('a.spec.ts', 212), fi('b.spec.ts', 180), th('z.spec.ts', 'light', 111), th('z.spec.ts', 'dark', 111)];
    expect(splitItems(items, 3).map(chunkSeconds)).toEqual([212, 180, 222]); // without the constraint they share the last piece
    const apart = splitItems(items, 3, { keepThemesApart: true });
    expect(apart.map(chunkSeconds)).toEqual([212, 291, 111]);
    expect(apart.flat()).toEqual(items);
    expect(apart[1]!.map((i) => i.name)).toEqual(['b.spec.ts', 'light']);
  });

  it('planChunk applies it: with two big files before z19 the cheapest cut would put both themes in the last piece, and it does not', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'chunk-theme-'));
    mkdirSync(path.join(tmp, SPEC_DIR), { recursive: true });
    writeFileSync(path.join(tmp, SPEC_DIR, CONTRAST_FILE), "const SCREENS = [\n  { slug: 'only', path: '/' },\n] as const;");
    for (const f of ['n-a11y-main-screens.spec.ts', 'o3-banner-titles.spec.ts', 'z19-native-selects.spec.ts']) writeFileSync(path.join(tmp, SPEC_DIR, f), '');
    const names = (p: number) => planChunk(tmp, 1, 1, p, 2).items.map((i) => i.name);
    // two pieces over 168, 159, 30 (the contrast screen), 145 (light), 143 (dark): the cheapest cut is 327 | 318 with both themes in the second
    // piece; kept apart, the only cut is between them: 502 | 143, light closing the first piece and dark alone
    expect(names(1)).toEqual(expect.not.arrayContaining(['dark']));
    expect(names(2)).toEqual(['dark']);
    expect(names(1)).toContain('light');
  });

  it('is the best split that keeps themes apart: on random inputs it matches a brute force over every cut set that does', () => {
    let seed = 11;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let t = 0; t < 300; t++) {
      const items: Item[] = [];
      for (let i = 0, n = 2 + rnd(7); i < n; i++) items.push(rnd(4) === 0 && i + 1 < n ? th('z.spec.ts', 'light', 10 + rnd(9) * 10) : fi(`s${i}.spec.ts`, 10 + rnd(9) * 10));
      for (let i = 1; i < items.length; i++) if (items[i - 1]!.kind === 'theme' && rnd(2)) items[i] = th('z.spec.ts', 'dark', 10 + rnd(9) * 10);
      const k = 2 + rnd(3);
      const n = items.length, parts = Math.min(k, n);
      const forced = [...Array(n).keys()].filter((b) => b > 0 && items[b - 1]!.kind === 'theme' && items[b]!.kind === 'theme');
      let best = Infinity;
      const walk = (start: number, left: number, max: number): void => {
        if (left === 1) { const w = items.slice(start).reduce((a, i) => a + i.seconds, 0); if (!forced.some((b) => b > start && b < n)) best = Math.min(best, Math.max(max, w)); return; }
        for (let end = start + 1; end <= n - (left - 1); end++) {
          if (forced.some((b) => b > start && b < end)) continue;
          walk(end, left - 1, Math.max(max, items.slice(start, end).reduce((a, i) => a + i.seconds, 0)));
        }
      };
      walk(0, parts, 0);
      if (best === Infinity) { expect(() => splitItems(items, k, { keepThemesApart: true }), JSON.stringify(items)).toThrow(/themes kept apart/); continue; }
      const got = splitItems(items, k, { keepThemesApart: true });
      expect(got.flat()).toEqual(items);
      expect(Math.max(...got.map(chunkSeconds)), JSON.stringify(items.map((i) => [i.kind, i.seconds]))).toBe(best);
      for (const part of got) for (let i = 1; i < part.length; i++) expect(part[i - 1]!.kind === 'theme' && part[i]!.kind === 'theme').toBe(false);
    }
  });

  it('forces a cut only between the themes of ONE file: neighbouring themes of two different files may share a piece', () => {
    const items = [th('y.spec.ts', 'light', 10), th('y.spec.ts', 'dark', 10), th('z.spec.ts', 'light', 10), th('z.spec.ts', 'dark', 10)];
    const parts = splitItems(items, 3, { keepThemesApart: true });
    expect(parts.map((p) => p.map((i) => `${i.kind === 'theme' ? i.file : ''}:${i.name}`))).toEqual([['y.spec.ts:light'], ['y.spec.ts:dark', 'z.spec.ts:light'], ['z.spec.ts:dark']]);
  });

  it('says so when no cut can keep them apart (themes of one file in a single piece)', () => {
    expect(() => splitItems([th('z.spec.ts', 'light', 5), th('z.spec.ts', 'dark', 5)], 1, { keepThemesApart: true })).toThrow(/themes kept apart/);
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

  it('minimises the longest chunk first: [30 20 50 10] in 3 is 50 / 50 / 10, not the more even-squared 30 / 20 / 60', () => {
    const parts = splitItems([30, 20, 50, 10].map((seconds, i): Item => ({ kind: 'file', name: `s${i}.spec.ts`, seconds })), 3);
    expect(parts.map(chunkSeconds)).toEqual([50, 50, 10]);
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

describe('invocationArgs', () => {
  const inv = { files: ['tests/e2e/golden-paths/a.spec.ts', 'tests/e2e/golden-paths/b.spec.ts'], grep: 'AA contrast' };

  it('adds nothing without GOLDEN_EVIDENCE=1 (the arguments every run had before)', () => {
    expect(invocationArgs(inv, 2, 0, {})).toEqual(['run', 'test:e2e:golden', ...inv.files, '--grep', 'AA contrast']);
    expect(invocationArgs({ files: ['x.spec.ts'] }, 1, 0, { GOLDEN_EVIDENCE: '0' })).toEqual(['run', 'test:e2e:golden', 'x.spec.ts']);
  });

  it('gives every run of a piece, and every piece, its own output directory under test-results/', () => {
    const env = { GOLDEN_EVIDENCE: '1' };
    const dirs = [[1, 0], [1, 1], [2, 0], [3, 0], [3, 1]].map(([piece, i]) => {
      const args = invocationArgs(inv, piece!, i!, env);
      return args[args.indexOf('--output') + 1];
    });
    expect(dirs).toEqual(['test-results/p1-i0', 'test-results/p1-i1', 'test-results/p2-i0', 'test-results/p3-i0', 'test-results/p3-i1']);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(invocationArgs(inv, 1, 0, env).slice(0, 5)).toEqual(['run', 'test:e2e:golden', ...inv.files, '--grep']);
  });
});
