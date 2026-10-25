import { describe, it, expect } from 'vitest';
import { applyPolicyFacts, type PolicyFacts } from '@/modules/accounting/services/afs/noteGenerators/note1PolicyFacts';
import { getAccountingPolicies } from '@/modules/accounting/services/afs/noteGenerators/noteHelpers';

type Policy = { heading: string; text: string };
const text = (ps: Policy[], heading: string) => ps.find((p) => p.heading === heading)?.text;
const facts = (f: Partial<PolicyFacts>): PolicyFacts => ({ depMethods: [], invMethods: [], holdsInventory: true, ...f });

describe('applyPolicyFacts', () => {
  it('one depreciation method: names it, with no per-asset qualifier', () => {
    const out = applyPolicyFacts(getAccountingPolicies('ifrs_smes'), facts({ depMethods: ['reducing_balance'] }));
    expect(text(out, 'Property, Plant and Equipment')).toContain('Depreciation is provided on the reducing-balance method to write down');
  });

  it('three depreciation methods mid-sentence: lists them in order, qualifier set off by commas', () => {
    const out = applyPolicyFacts(getAccountingPolicies('full_ifrs'), facts({ depMethods: ['straight_line', 'reducing_balance', 'sum_of_years'] }));
    expect(text(out, 'Property, Plant and Equipment')).toContain(
      "calculated using the straight-line, reducing-balance or sum-of-the-years'-digits method, as set for each asset, over the estimated useful life.",
    );
  });

  it('two cost methods ending a sentence: no comma before the full stop', () => {
    const out = applyPolicyFacts(getAccountingPolicies('ifrs_smes'), facts({ invMethods: ['weighted_average', 'fifo'] }));
    expect(text(out, 'Inventories')).toContain('using the weighted average cost or first-in, first-out (FIFO) method, as set for each item. Write-downs');
    expect(text(out, 'Inventories')).not.toContain(',.');
  });

  it('FIFO alone replaces the weighted average wording in both frameworks', () => {
    for (const fw of ['ifrs_smes', 'full_ifrs'] as const) {
      const inv = text(applyPolicyFacts(getAccountingPolicies(fw), facts({ invMethods: ['fifo'] })), 'Inventories')!;
      expect(inv).toContain('the first-in, first-out (FIFO) method');
      expect(inv).not.toMatch(/weighted average/);
    }
  });

  it('nothing recorded: the framework text is untouched; no inventory: only the inventories policy goes', () => {
    const base = getAccountingPolicies('ifrs_smes');
    expect(applyPolicyFacts(base, facts({}))).toEqual(base);
    const out = applyPolicyFacts(base, facts({ holdsInventory: false }));
    expect(out.map((p) => p.heading)).toEqual(base.map((p) => p.heading).filter((h) => h !== 'Inventories'));
  });
});
