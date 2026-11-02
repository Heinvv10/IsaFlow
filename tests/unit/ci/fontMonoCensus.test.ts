/**
 * font-mono census (master plan wave 3, V). An ID is set in the app face with `font-id` (tabular figures, slashed
 * zero); a monospace face is for code alone. Each file still using `font-mono` is on eslint/font-mono-allowlist.json
 * with its count. The list only shrinks: a new file or a higher count fails, a file that got cleaner must lower its
 * entry (bun scripts/ci/check-font-mono-allowlist.ts --write), and an entry may not be added or raised against
 * origin/master. Reads `git ls-files` through the same gate the CLI runs, so a file that is not tracked is not seen.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../../tailwind.config.mjs';
import { compareCounts, runGate } from '../../../scripts/ci/rawInputAllowlist';
import { FONT_MONO_LIST, countFontMono, fontMonoCounts, trackedSources } from '../../../scripts/ci/fontMonoCensus';

const ROOT = process.cwd();
const git = (args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8');

describe('countFontMono', () => {
  it('counts each use of the utility, variants included', () => {
    expect(countFontMono('<td className="font-mono">a</td><b className="md:font-mono text-xs">b</b>')).toBe(2);
  });

  it('does not count a longer name that contains it', () => {
    expect(countFontMono('<i className="pack-font-mono font-mono-tight" />')).toBe(0);
  });

  it('does not count font-id', () => {
    expect(countFontMono('<td className="font-id">a</td>')).toBe(0);
  });
});

describe('fontMonoCounts', () => {
  it('reports only the .ts and .tsx files that use it', () => {
    const files: Record<string, string> = { 'a.tsx': 'font-mono', 'b.ts': 'font-mono font-mono', 'c.tsx': 'font-id', 'd.css': 'font-mono', 'e.md': 'font-mono' };
    expect({ ...fontMonoCounts(Object.keys(files), (f) => files[f]!) }).toEqual({ 'a.tsx': 1, 'b.ts': 2 });
  });
});

describe('the list as a gate', () => {
  it('refuses a new file and a raised count, and names font-id as the fix', () => {
    const problems = compareCounts({ 'a.tsx': 1 }, { 'a.tsx': 2, 'b.tsx': 1 }, { 'a.tsx': 1 }, 'origin/master', FONT_MONO_LIST);
    expect(problems.some((p) => p.startsWith('NEW: b.tsx') && p.includes('font-id'))).toBe(true);
    expect(problems.some((p) => p.startsWith('GROWN: a.tsx') && p.includes('font-id'))).toBe(true);
  });

  it('asks a file that got cleaner to lower its entry, with this list\'s own command', () => {
    const [problem] = compareCounts({ 'a.tsx': 2 }, { 'a.tsx': 1 }, null, '', FONT_MONO_LIST);
    expect(problem).toContain('SHRUNK: a.tsx');
    expect(problem).toContain('bun scripts/ci/check-font-mono-allowlist.ts --write');
  });

  it('refuses an entry added or raised against the base, even when the tree agrees with the list', () => {
    const problems = compareCounts({ 'a.tsx': 2, 'b.tsx': 1 }, { 'a.tsx': 2, 'b.tsx': 1 }, { 'a.tsx': 1 }, 'origin/master', FONT_MONO_LIST);
    expect(problems.some((p) => p.startsWith('ADDED: b.tsx'))).toBe(true);
    expect(problems.some((p) => p.startsWith('RAISED: a.tsx'))).toBe(true);
  });
});

describe('the tree', () => {
  it('matches eslint/font-mono-allowlist.json, and the list has not grown against origin/master', async () => {
    const problems: string[] = [];
    const code = await runGate({
      env: process.env, writing: false, git,
      actualCounts: async () => fontMonoCounts(trackedSources(git), read),
      readList: () => read(FONT_MONO_LIST.path),
      writeList: () => { throw new Error('the census never writes'); },
      log: () => undefined,
      error: (line) => problems.push(line),
      list: FONT_MONO_LIST,
    });
    expect(problems.filter((p) => !p.includes(' warn: '))).toEqual([]);
    expect(code).toBe(0);
  });

  it('sees files that use font-mono, so a broken listing cannot pass as a clean tree', () => {
    expect(Object.keys(fontMonoCounts(trackedSources(git), read)).length).toBeGreaterThan(100);
  });
});

describe('the mono stack', () => {
  it('is the system code faces, without Monaco', () => {
    const { fontFamily } = (tailwindConfig as { theme: { extend: { fontFamily: Record<string, string[]> } } }).theme.extend;
    expect(fontFamily.mono).toEqual(['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']);
  });
});
