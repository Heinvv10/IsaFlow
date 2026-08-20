/**
 * AFS Note 1 must never describe a non-VAT-vendor as accounting for VAT.
 *
 * Both accounting-policy generators used to read `vat_system_type` raw, so a
 * company created as "not registered for VAT" (which writes vat_period='none'
 * and left vat_system_type on its 'invoice' default) got the sentence
 * "VAT is accounted for on the invoice basis as registered with SARS" in a
 * signed financial statement.
 */
import { describe, it, expect } from 'vitest';
import { getAccountingPolicies } from '@/modules/accounting/services/afs/noteGenerators/noteHelpers';

const taxationText = (policies: Array<{ heading: string; text: string }>) =>
  policies.find((p) => p.heading === 'Taxation')?.text ?? '';

describe('getAccountingPolicies — VAT policy sentence', () => {
  it('states the basis for a registered vendor', () => {
    const text = taxationText(
      getAccountingPolicies('ifrs_smes', { vatBasis: 'payment', vatRegistered: true }),
    );
    expect(text).toContain('accounts for VAT on the payment basis');
  });

  it('says NOT registered — and never names a basis — for a non-vendor', () => {
    const text = taxationText(
      // vatBasis is still supplied: this is exactly the state the old code hit,
      // where vat_system_type said 'invoice' but the company is not a vendor.
      getAccountingPolicies('ifrs_smes', { vatBasis: 'invoice', vatRegistered: false }),
    );
    expect(text).toContain('not registered for Value Added Tax');
    expect(text).not.toContain('accounts for VAT on the');
    expect(text).not.toContain('invoice basis');
  });

  it('omits the VAT sentence entirely when registration is unspecified', () => {
    const text = taxationText(getAccountingPolicies('ifrs_smes'));
    expect(text).not.toContain('accounts for VAT on the');
    expect(text).not.toContain('not registered for Value Added Tax');
  });

  it('applies to every framework', () => {
    for (const fw of ['ifrs_smes', 'ifrs_full'] as const) {
      const text = taxationText(getAccountingPolicies(fw, { vatBasis: 'invoice', vatRegistered: false }));
      expect(text).toContain('not registered for Value Added Tax');
    }
  });
});
