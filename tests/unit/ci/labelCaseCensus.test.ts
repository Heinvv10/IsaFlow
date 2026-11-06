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
const SELF = 'tests/unit/ci/labelCaseCensus.test.ts';
// A `<label ...>` opening tag whose attributes (any order, any spacing) carry the `uppercase` utility, or the old
// label class string. Named limit: classes built through cn()/template variables are not seen.
const LABEL_UPPERCASE = /<label\b[^>]*\buppercase\b/;
const OLD_CLASS = /uppercase\s+tracking-wider\s+mb-1\.5|mb-1\.5\s+uppercase/;

export const findOffenders = (files: Record<string, string>): string[] =>
  Object.entries(files).filter(([, src]) => LABEL_UPPERCASE.test(src) || OLD_CLASS.test(src)).map(([f]) => f).sort();

describe('findOffenders', () => {
  it('flags the old label class', () => {
    expect(findOffenders({ 'a.tsx': "const lbl = 'block uppercase tracking-wider mb-1.5';" })).toEqual(['a.tsx']);
  });

  it('flags a reordered class and a label element with uppercase', () => {
    expect(findOffenders({ 'a.tsx': "'mb-1.5 uppercase tracking-wider'" })).toEqual(['a.tsx']);
    expect(findOffenders({ 'b.tsx': '<label className="text-xs tracking-wide uppercase mb-1">' })).toEqual(['b.tsx']);
  });

  it('passes the kit label and other uppercase uses', () => {
    expect(findOffenders({ 'a.tsx': "'block text-sm font-medium mb-1.5'", 'b.tsx': "'uppercase tracking-wider text-xs'" })).toEqual([]);
  });
});

describe('label case census', () => {
  it('no tracked ts/tsx file uses uppercase tracking-wider mb-1.5', () => {
    const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean).filter((f) => f !== SELF);
    const files: Record<string, string> = {};
    for (const f of tracked) files[f] = readFileSync(join(ROOT, f), 'utf8');
    expect(findOffenders(files)).toEqual([]);
  });
});
