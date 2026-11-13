import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_FILE, CONTRAST_SECONDS, CONTRAST_TITLE_TAIL, FILE_SECONDS, SPEC_DIR, chunkSeconds, contrastSlugs, planChunk, planItems,
  splitItems, toInvocations,
} from '../../../scripts/ci/golden-hosted/goldenChunkPlan';

const ROOT = path.resolve(__dirname, '../../..');
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

  it('keeps the chunks within 25% of each other, none empty, none over 12 minutes of measured test time', () => {
    const secs = Array.from({ length: N }, (_, i) => chunkSeconds(planChunk(ROOT, i + 1, N).items));
    expect(Math.min(...secs)).toBeGreaterThan(0);
    expect(Math.max(...secs) / Math.min(...secs)).toBeLessThan(1.25);
    expect(Math.max(...secs)).toBeLessThan(12 * 60);
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
