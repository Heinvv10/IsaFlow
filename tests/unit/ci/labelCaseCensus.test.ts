/**
 * Label-case census (master plan wave 4, VC). A field label is sentence case in the kit's `text-sm font-medium`;
 * uppercase is for eyebrows and table headers. The old label class (`uppercase tracking-wider mb-1.5`) must not come
 * back in code. Reads `git ls-files` for ts/tsx only: `.claude.md` and `AGENTS.md` quote the pattern on purpose.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const PATTERN = /uppercase\s+tracking-wider\s+mb-1\.5/;

export const findOffenders = (files: Record<string, string>): string[] =>
  Object.entries(files).filter(([, src]) => PATTERN.test(src)).map(([f]) => f).sort();

describe('findOffenders', () => {
  it('flags the old label class', () => {
    expect(findOffenders({ 'a.tsx': "const lbl = 'block uppercase tracking-wider mb-1.5';" })).toEqual(['a.tsx']);
  });

  it('passes the kit label and other uppercase uses', () => {
    expect(findOffenders({ 'a.tsx': "'block text-sm font-medium mb-1.5'", 'b.tsx': "'uppercase tracking-wider text-xs'" })).toEqual([]);
  });
});

describe('label case census', () => {
  it('no tracked ts/tsx file uses uppercase tracking-wider mb-1.5', () => {
    const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean).filter((f) => !f.startsWith('tests/unit/ci/labelCaseCensus'));
    const files: Record<string, string> = {};
    for (const f of tracked) files[f] = readFileSync(join(ROOT, f), 'utf8');
    expect(findOffenders(files)).toEqual([]);
  });
});
