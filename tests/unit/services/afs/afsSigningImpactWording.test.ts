/**
 * The signing fingerprint covers companies.name and companies.registration_number — what the
 * cover prints. The settings page also has a separate "Registered Name" field
 * (companies.registered_name) that the render never prints, so editing it voids nothing. A
 * warning or refusal that says "the registered company name" names the one field that does NOT
 * void a signature, and sends the operator to the wrong input.
 */
import { describe, expect, it } from 'vitest';
import {
  signatureRefusalReason,
  withSignatureImpactWarnings,
  type Query,
  type SigningInputDigests,
} from '@/modules/accounting/services/afs/afsSigningIntegrity';

/** Answers each statement with the next queued result set, in order. */
function queuedQuery(results: unknown[][]): Query {
  return async () => {
    const next = results.shift();
    if (!next) throw new Error('unexpected statement');
    return next;
  };
}
const digests = (company: string): SigningInputDigests => ({ document: 'd', company, brand: 'b', sections: 's' });
const snapshot = (company: string) => [{
  fingerprint: `fp-${company}`, digests: digests(company),
  company_name: 'Acme (Pty) Ltd', company_registration: '2019/000001/07', brand_row: null,
}];

describe('what a company-input change is called', () => {
  it('the refusal names the company name or registration number, not the registered name', async () => {
    const q = queuedQuery([[{ cnt: 0 }], snapshot('after')]);
    const reason = await signatureRefusalReason(q, 'co', 'doc', { fingerprint: 'fp-before', digests: digests('before') });
    expect(reason).toBe('Changed after the document was sent for signature: the company name or registration number');
    expect(reason).not.toMatch(/registered/i);
  });

  it('the save warning names the company name or registration number, not the registered name', async () => {
    const q = queuedQuery([[{ id: 'doc', fiscal_year: 2026, period: null }], snapshot('before'), snapshot('after')]);
    const { warnings } = await withSignatureImpactWarnings(q, 'co', async () => 'saved');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('this change to the company name or registration number will cause its signature to be refused');
    expect(warnings[0]).not.toMatch(/registered/i);
  });
});
