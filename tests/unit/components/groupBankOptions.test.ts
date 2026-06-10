import { describe, it, expect } from 'vitest';
import { groupBankAccountOptions } from '@/components/accounting/bank/groupBankOptions';

interface Opt { id: string; parentAccountId: string | null; label: string }
const o = (id: string, parentAccountId: string | null = null): Opt => ({
  id, parentAccountId, label: `acct-${id}`,
});

describe('groupBankAccountOptions', () => {
  it('returns all accounts as primaries when none have a parent in the list', () => {
    const res = groupBankAccountOptions([o('1'), o('2'), o('3')]);
    expect(res.primaries.map(a => a.id)).toEqual(['1', '2', '3']);
    expect(res.groups).toEqual([]);
  });

  it('buckets children under their umbrella and drops the umbrella from options', () => {
    const res = groupBankAccountOptions([o('U'), o('c1', 'U'), o('c2', 'U'), o('P')]);
    expect(res.primaries.map(a => a.id)).toEqual(['P']);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]!.umbrella.id).toBe('U');
    expect(res.groups[0]!.children.map(a => a.id)).toEqual(['c1', 'c2']);
  });

  it('supports multiple groups, preserving input order', () => {
    const res = groupBankAccountOptions([o('A'), o('a1', 'A'), o('B'), o('b1', 'B')]);
    expect(res.groups.map(g => g.umbrella.id)).toEqual(['A', 'B']);
  });

  it('treats a child whose parent is absent from the list as a primary', () => {
    const res = groupBankAccountOptions([o('x', 'GONE'), o('y')]);
    expect(res.primaries.map(a => a.id)).toEqual(['x', 'y']);
    expect(res.groups).toEqual([]);
  });

  it('keeps an umbrella unselectable even when it is itself a child; drops empty groups', () => {
    // G is m's parent, m is n's parent. Both G and m are umbrellas → neither is
    // a selectable option. n nests under m. G's only member (m) is an umbrella,
    // so group G has no selectable children and is dropped.
    const res = groupBankAccountOptions([o('G'), o('m', 'G'), o('n', 'm')]);
    expect(res.primaries).toEqual([]);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]!.umbrella.id).toBe('m');
    expect(res.groups[0]!.children.map(a => a.id)).toEqual(['n']);
  });
});
