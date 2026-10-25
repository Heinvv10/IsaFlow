import { describe, it, expect } from 'vitest';
import { compareCounts, parseCounts, pruneCounts, readBaseList, type GitRunner } from '../../../scripts/ci/rawInputAllowlist';

const REF = 'origin/master';
const PATH = 'eslint/raw-input-allowlist.json';

/** A fake git: `files` is what the ref holds; a missing ref makes rev-parse fail. */
function fakeGit(opts: { ref?: boolean; files?: Record<string, string>; failOn?: string }): GitRunner {
  return (args) => {
    if (opts.failOn && args[0] === opts.failOn) throw new Error(`git ${args[0]} failed (fatal: bad object)`);
    if (args[0] === 'rev-parse') {
      if (opts.ref === false) throw new Error('unknown revision');
      return 'abc123\n';
    }
    if (args[0] === 'ls-tree') return Object.keys(opts.files ?? {}).includes(args[4] as string) ? `${args[4]}\n` : '';
    if (args[0] === 'show') {
      const file = (args[1] as string).split(':')[1] as string;
      const text = opts.files?.[file];
      if (text === undefined) throw new Error('path not in ref');
      return text;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

describe('readBaseList', () => {
  it('a missing ref is no-ref', () => {
    expect(readBaseList(REF, PATH, fakeGit({ ref: false }))).toEqual({ kind: 'no-ref' });
  });

  it('a ref without the list is no-list: this change introduces it', () => {
    expect(readBaseList(REF, PATH, fakeGit({ files: { 'package.json': '{}' } }))).toEqual({ kind: 'no-list' });
  });

  it('a ref with the list returns its counts', () => {
    const git = fakeGit({ files: { [PATH]: '{"a.tsx": 2, "b.tsx": 1}' } });
    expect(readBaseList(REF, PATH, git)).toEqual({ kind: 'list', counts: { 'a.tsx': 2, 'b.tsx': 1 } });
  });

  it.each([
    ['not JSON', '{oops'],
    ['an array (the old format)', '["a.tsx"]'],
    ['null', 'null'],
    ['a zero count', '{"a.tsx": 0}'],
    ['a fractional count', '{"a.tsx": 1.5}'],
    ['a string count', '{"a.tsx": "2"}'],
    ['an empty string', ''],
  ])('a base list that is %s fails the gate instead of reading as "no list"', (_name, text) => {
    expect(() => readBaseList(REF, PATH, fakeGit({ files: { [PATH]: text } }))).toThrow();
  });

  it('a git failure other than "no such path" fails the gate', () => {
    expect(() => readBaseList(REF, PATH, fakeGit({ files: { [PATH]: '{}' }, failOn: 'ls-tree' }))).toThrow(/ls-tree failed/);
    expect(() => readBaseList(REF, PATH, fakeGit({ files: { [PATH]: '{"a.tsx":1}' }, failOn: 'show' }))).toThrow(/show failed/);
  });
});

describe('parseCounts', () => {
  it('names the file and the entry that is wrong', () => {
    expect(() => parseCounts('{"x.tsx": -1}', 'the list')).toThrow(/the list: "x.tsx" must have a positive integer/);
    expect(() => parseCounts('{bad', 'the list')).toThrow(/the list is not valid JSON/);
  });
  it('does not let a file called __proto__ reach the prototype', () => {
    const counts = parseCounts('{"__proto__": 2}', 'the list');
    expect(Object.keys(counts)).toEqual(['__proto__']);
    expect(({} as Record<string, number>).polluted).toBeUndefined();
  });
});

describe('compareCounts', () => {
  const none = null;
  it('is quiet when the list matches the tree and the base', () => {
    expect(compareCounts({ 'a.tsx': 2 }, { 'a.tsx': 2 }, { 'a.tsx': 2 }, REF)).toEqual([]);
    expect(compareCounts({ 'a.tsx': 2 }, { 'a.tsx': 2 }, { 'a.tsx': 5, 'gone.tsx': 1 }, REF)).toEqual([]);
  });

  it('NEW: a violating file that is not listed', () => {
    const p = compareCounts({}, { 'new.tsx': 1 }, none, REF);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^NEW: new\.tsx/);
  });

  it('GROWN: a listed file gained a raw input', () => {
    const p = compareCounts({ 'a.tsx': 2 }, { 'a.tsx': 3 }, none, REF);
    expect(p[0]).toMatch(/^GROWN: a\.tsx now has 3 \(list says 2\)/);
  });

  it('SHRUNK: a listed file improved but the count was not lowered', () => {
    const p = compareCounts({ 'a.tsx': 3 }, { 'a.tsx': 1 }, none, REF);
    expect(p[0]).toMatch(/^SHRUNK: a\.tsx now has 1 \(list says 3\)/);
  });

  it('STALE: a listed file that no longer violates or is gone', () => {
    const p = compareCounts({ 'a.tsx': 3 }, {}, none, REF);
    expect(p[0]).toMatch(/^STALE: a\.tsx/);
  });

  it('ADDED / RAISED against the base ref', () => {
    const p = compareCounts({ 'a.tsx': 2, 'b.tsx': 4 }, { 'a.tsx': 2, 'b.tsx': 4 }, { 'b.tsx': 3 }, REF);
    expect(p.map((x) => x.split(':')[0])).toEqual(['ADDED', 'RAISED']);
    expect(p[0]).toContain('a.tsx');
    expect(p[1]).toContain('b.tsx is 4 on the list but 3 on origin/master');
  });

  it('lowering a count against the base is fine', () => {
    expect(compareCounts({ 'b.tsx': 2 }, { 'b.tsx': 2 }, { 'b.tsx': 3 }, REF)).toEqual([]);
  });
});

describe('pruneCounts (--write)', () => {
  it('lowers counts and drops fixed files, never adds a file or raises a count', () => {
    expect(pruneCounts({ 'a.tsx': 3, 'b.tsx': 2, 'c.tsx': 1 }, { 'a.tsx': 1, 'b.tsx': 5, 'new.tsx': 4 })).toEqual({
      'a.tsx': 1,
      'b.tsx': 2,
    });
  });
});
