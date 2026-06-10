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

  it('groups only one level: a child-of-a-child nests under its direct parent', () => {
    const res = groupBankAccountOptions([o('G'), o('m', 'G'), o('n', 'm')]);
    const ids = res.groups.map(g => g.umbrella.id).sort();
    expect(ids).toEqual(['G', 'm']);
    const gGroup = res.groups.find(g => g.umbrella.id === 'G')!;
    const mGroup = res.groups.find(g => g.umbrella.id === 'm')!;
    expect(gGroup.children.map(a => a.id)).toEqual(['m']);
    expect(mGroup.children.map(a => a.id)).toEqual(['n']);
    expect(res.primaries).toEqual([]);
  });
});
