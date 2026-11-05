/**
 * billDueDate: a due date given > the bill's own chosen terms > the supplier's CONFIRMED terms > terms text from the
 * scan > the company default. A scan never overrides a confirmed supplier (Hein, 2026-11-05): CFS (90 days after the
 * statement, 3 months) dates 16 Sep -> 31 Dec, not net90's 15 Dec.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const contactTerms = vi.fn();
vi.mock('@/modules/accounting/services/core/paymentTermsResolver', () => ({ contactTerms: (...a: unknown[]) => contactTerms(...a) }));

import { billDueDate } from '@/modules/accounting/services/ap/billDueDate';

const DEFAULT30 = { days: 30, type: 'invoice_days' as const };
const supplier = (days: number | null, type: string | null) => contactTerms.mockResolvedValue({ days, type, companyDefault: DEFAULT30 });
const due = (given: Parameters<typeof billDueDate>[3]) => billDueDate('co', 'sup', '2026-09-16', given);

beforeEach(() => { contactTerms.mockReset(); });

describe('billDueDate precedence', () => {
  it('CFS: supplier 3 months after statement, scan says "90 days after statement": 31 Dec', async () => {
    supplier(3, 'statement_months');
    expect(await due({ scannedTerms: '90 days after statement' })).toBe('2026-12-31');
  });
  it('a scan that says "Net 90" does not override the supplier\'s confirmed terms', async () => {
    supplier(3, 'statement_months');
    expect(await due({ scannedTerms: 'Net 90 days' })).toBe('2026-12-31');
  });
  it('a supplier with terms NOT confirmed: the scan\'s netNN dates it', async () => {
    supplier(null, null);
    expect(await due({ scannedTerms: 'Net 60' })).toBe('2026-11-15');
  });
  it('unconfirmed supplier and statement wording on the scan: ignored, the company default dates it', async () => {
    supplier(null, null);
    expect(await due({ scannedTerms: '90 days after statement' })).toBe('2026-10-16');
  });
  it('unconfirmed supplier, nothing on the scan: the company default', async () => {
    supplier(null, null);
    expect(await due({})).toBe('2026-10-16');
  });
  it('terms the caller explicitly chose beat the supplier\'s', async () => {
    supplier(3, 'statement_months');
    expect(await due({ paymentTerms: 'net30', scannedTerms: 'Net 90' })).toBe('2026-10-16');
  });
  it('a due date given (typed, or printed on the document) beats every terms input', async () => {
    supplier(3, 'statement_months');
    expect(await due({ dueDate: '2026-11-01', paymentTerms: 'net30', scannedTerms: 'Net 90' })).toBe('2026-11-01');
    expect(contactTerms).not.toHaveBeenCalled();
  });
});
