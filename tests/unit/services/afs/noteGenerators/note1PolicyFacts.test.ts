import { describe, it, expect } from 'vitest';
import { applyPolicyFacts } from '@/modules/accounting/services/afs/noteGenerators/note1PolicyFacts';
import { getAccountingPolicies } from '@/modules/accounting/services/afs/noteGenerators/noteHelpers';

const ppe = (ps: Array<{ heading: string; text: string }>) => ps.find((p) => p.heading === 'Property, Plant and Equipment')!.text;

describe('applyPolicyFacts', () => {
  it('one method: names it, with no per-asset qualifier', () => {
    const out = applyPolicyFacts(getAccountingPolicies('ifrs_smes'), { depMethods: ['reducing_balance'], holdsInventory: true });
    expect(ppe(out)).toContain('Depreciation is provided on the reducing-balance method to write down');
  });

  it('three methods: lists them in order, says each asset carries its own', () => {
    const out = applyPolicyFacts(getAccountingPolicies('full_ifrs'), {
      depMethods: ['straight_line', 'reducing_balance', 'sum_of_years'], holdsInventory: true,
    });
    expect(ppe(out)).toContain(
      "calculated using the straight-line, reducing-balance or sum-of-the-years'-digits method, as set for each asset, over the estimated useful life.",
    );
  });

  it('no assets: the framework text is untouched; no inventory: the inventories policy is removed, nothing else', () => {
    const base = getAccountingPolicies('ifrs_smes');
    const out = applyPolicyFacts(base, { depMethods: [], holdsInventory: false });
    expect(ppe(out)).toBe(ppe(base));
    expect(out.map((p) => p.heading)).toEqual(base.map((p) => p.heading).filter((h) => h !== 'Inventories'));
  });
});
