import { describe, it, expect, vi } from 'vitest';
import { runGate, type GateDeps, type GitRunner } from '../../../scripts/ci/rawInputAllowlist';

const LIST = 'eslint/raw-input-allowlist.json';

/** A git whose ref `origin/master` (or `ref`) holds `baseText` at the list path; null = no list; false = no ref. */
function git(baseText: string | null | false, ref = 'origin/master'): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((args: string[]) => {
    calls.push(args);
    if (baseText === false) throw new Error('unknown revision');
    if (args[0] === 'rev-parse') return 'abc\n';
    if (args[0] === 'ls-tree') return baseText === null ? '' : `${LIST}\n`;
    if (args[0] === 'show') {
      expect(args[1]).toBe(`${ref}:${LIST}`);
      return baseText as string;
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  }) as GitRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function deps(over: Partial<GateDeps> = {}) {
  const out = { log: [] as string[], error: [] as string[], written: [] as unknown[] };
  const d: GateDeps = {
    env: {},
    writing: false,
    git: git(null),
    actualCounts: vi.fn(async () => ({ 'a.tsx': 2 })),
    readList: () => '{"a.tsx": 2}',
    writeList: (c) => out.written.push(c),
    log: (l) => out.log.push(l),
    error: (l) => out.error.push(l),
    ...over,
  };
  return { d, out };
}

describe('runGate: the base-ref override in CI', () => {
  it.each([
    [{ GITHUB_ACTIONS: 'true' }],
    [{ GITHUB_ACTIONS: '1' }],
    [{ GITHUB_ACTIONS: 'True' }],
    [{ CI: 'true' }],
    [{ CI: '1' }],
  ])('%j: exit 1 with FAIL, before ESLint or git run', async (ci) => {
    const g = git(null);
    const { d, out } = deps({ env: { ...ci, RAW_INPUT_BASE_REF: 'HEAD' }, git: g });
    expect(await runGate(d)).toBe(1);
    expect(out.error.join('\n')).toMatch(/FAIL: RAW_INPUT_BASE_REF is set \(HEAD\) in CI/);
    expect(d.actualCounts).not.toHaveBeenCalled();
    expect(g.calls).toEqual([]);
  });

  it('locally the override is used for the comparison', async () => {
    const g = git('{"a.tsx": 2}', 'refs/tmp/base');
    const { d, out } = deps({ env: { RAW_INPUT_BASE_REF: 'refs/tmp/base' }, git: g });
    expect(await runGate(d)).toBe(0);
    expect(g.calls.some((c) => c.join(' ').includes('refs/tmp/base'))).toBe(true);
    expect(out.error).toEqual([]);
  });
});

describe('runGate --write in CI', () => {
  it('also refuses the override: --write does not read the base, but a CI that sets it is wrong', async () => {
    const { d, out } = deps({ writing: true, env: { CI: '1', RAW_INPUT_BASE_REF: 'HEAD' } });
    expect(await runGate(d)).toBe(1);
    expect(out.error.join('\n')).toMatch(/RAW_INPUT_BASE_REF is set \(HEAD\) in CI/);
    expect(d.actualCounts).not.toHaveBeenCalled();
    expect(out.written).toEqual([]);
  });

  it('locally --write ignores the override and prunes', async () => {
    const { d, out } = deps({ writing: true, env: { RAW_INPUT_BASE_REF: 'HEAD' }, readList: () => '{"a.tsx": 3}' });
    expect(await runGate(d)).toBe(0);
    expect(out.written).toEqual([{ 'a.tsx': 2 }]);
  });
});

describe('runGate: outcomes', () => {
  it('passes when the list matches the tree and there is no list on the base yet', async () => {
    const { d, out } = deps();
    expect(await runGate(d)).toBe(0);
    expect(out.log.join('\n')).toMatch(/has no allowlist yet/);
    expect(out.log.join('\n')).toMatch(/ok: 1 files \(2 reports\)/);
  });

  it('passes when the base has the same count', async () => {
    expect(await runGate(deps({ git: git('{"a.tsx": 2}') }).d)).toBe(0);
  });

  it('fails RAISED against a smaller base', async () => {
    const { d, out } = deps({ git: git('{"a.tsx": 1}') });
    expect(await runGate(d)).toBe(1);
    expect(out.error.join('\n')).toMatch(/RAISED: a\.tsx is 2 on the list but 1 on origin\/master/);
  });

  it('fails NEW and GROWN against the tree', async () => {
    const { d, out } = deps({ actualCounts: async () => ({ 'a.tsx': 3, 'new.tsx': 1 }) });
    expect(await runGate(d)).toBe(1);
    expect(out.error.join('\n')).toMatch(/GROWN: a\.tsx/);
    expect(out.error.join('\n')).toMatch(/NEW: new\.tsx/);
  });

  it('a missing list file fails', async () => {
    const { d, out } = deps({ readList: () => null });
    expect(await runGate(d)).toBe(1);
    expect(out.error.join('\n')).toMatch(/is missing/);
  });

  it('an unparseable committed list throws (exit 2 in the CLI)', async () => {
    await expect(runGate(deps({ readList: () => '[' }).d)).rejects.toThrow(/not valid JSON/);
  });

  it('a malformed base list throws instead of reading as "no list"', async () => {
    await expect(runGate(deps({ git: git('{oops') }).d)).rejects.toThrow(/not valid JSON/);
  });
});

describe('runGate: a base ref that does not exist', () => {
  it('warns locally and passes', async () => {
    const { d, out } = deps({ git: git(false) });
    expect(await runGate(d)).toBe(0);
    expect(out.error.join('\n')).toMatch(/warn: base ref origin\/master is not available/);
  });

  it.each([[{ GITHUB_ACTIONS: 'true' }], [{ CI: '1' }], [{ GITHUB_ACTIONS: 'True' }]])('%j: FAIL, exit 1', async (ci) => {
    const { d, out } = deps({ env: ci, git: git(false) });
    expect(await runGate(d)).toBe(1);
    expect(out.error.join('\n')).toMatch(/FAIL: base ref origin\/master is not available/);
  });
});

describe('runGate --write', () => {
  it('writes the whole tree when there is no list yet', async () => {
    const { d, out } = deps({ writing: true, readList: () => null });
    expect(await runGate(d)).toBe(0);
    expect(out.written).toEqual([{ 'a.tsx': 2 }]);
  });

  it('prunes, never raises, and still fails on a NEW file', async () => {
    const { d, out } = deps({
      writing: true,
      readList: () => '{"a.tsx": 3, "gone.tsx": 1}',
      actualCounts: async () => ({ 'a.tsx': 2, 'new.tsx': 1 }),
    });
    expect(await runGate(d)).toBe(1);
    expect(out.written).toEqual([{ 'a.tsx': 2 }]);
  });
});
