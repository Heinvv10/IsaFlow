/**
 * A bill created over MCP with a due_date that disagrees with the supplier's OWN payment terms keeps the date it was
 * given (plan 2026-11-05: a date the caller or document gave wins) but comes back with a warning, so an agent copying
 * another system's due date (Sage's invoice + 90 for a "3 months after statement" supplier, 2026-11-10) notices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/paymentTermsResolver', () => ({ contactTerms: vi.fn() }));

import { contactTerms } from '@/modules/accounting/services/core/paymentTermsResolver';
import { dueDateTermsWarnings } from '@/lib/mcp/tools/dueDateTermsWarning';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CFS = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const DEFAULT = { days: 30, type: 'invoice_days' as const };

function terms(days: number | null, type: string | null) {
  return { days, type, companyDefault: DEFAULT };
}

describe('dueDateTermsWarnings', () => {
  beforeEach(() => {
    vi.mocked(contactTerms).mockReset();
  });

  it('warns when the given due date differs from the supplier terms, naming both dates', async () => {
    vi.mocked(contactTerms).mockResolvedValue(terms(3, 'statement_months'));
    const w = await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: '2027-02-07', label: '' },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('2027-02-07');
    expect(w[0]).toContain('2027-02-28');
  });

  it('is silent when the given date matches the supplier terms', async () => {
    vi.mocked(contactTerms).mockResolvedValue(terms(3, 'statement_months'));
    expect(await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: '2027-02-28', label: '' },
    ])).toEqual([]);
  });

  it('is silent, without a read, when no due date was given (the terms then apply)', async () => {
    expect(await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: undefined, label: '' },
    ])).toEqual([]);
    expect(contactTerms).not.toHaveBeenCalled();
  });

  it('is silent when the supplier has no terms set (the company default is not the supplier\'s terms)', async () => {
    vi.mocked(contactTerms).mockResolvedValue(terms(null, null));
    expect(await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: '2026-11-20', label: '' },
    ])).toEqual([]);
  });

  it('is silent when the given date is what the bill\'s OWN payment_terms (netNN) give', async () => {
    vi.mocked(contactTerms).mockResolvedValue(terms(3, 'statement_months'));
    expect(await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: '2027-01-08', paymentTerms: 'net60', label: '' },
    ])).toEqual([]);
  });

  it('still warns when the bill\'s own terms give a different date from the one given', async () => {
    vi.mocked(contactTerms).mockResolvedValue(terms(3, 'statement_months'));
    expect(await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: '2027-02-07', paymentTerms: 'net60', label: '' },
    ])).toHaveLength(1);
  });

  it('still warns when the bill\'s own terms are statement wording ("Net 90 EOM" is not a netNN)', async () => {
    vi.mocked(contactTerms).mockResolvedValue(terms(3, 'statement_months'));
    expect(await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: '2027-02-07', paymentTerms: 'Net 90 EOM', label: '' },
    ])).toHaveLength(1);
  });

  it('is silent for an invoice date the terms cannot date (dueDateFromTerms gives null)', async () => {
    vi.mocked(contactTerms).mockResolvedValue(terms(3, 'statement_months'));
    expect(await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-02-30', dueDate: '2026-05-31', label: '' },
    ])).toEqual([]);
  });

  it('prefixes the element label and reads each supplier once per call', async () => {
    vi.mocked(contactTerms).mockImplementation(async (_c, _k, id) => (
      id === CFS ? terms(3, 'statement_months') : terms(30, 'invoice_days')));
    const w = await dueDateTermsWarnings(COMPANY, [
      { supplierId: CFS, invoiceDate: '2026-11-09', dueDate: '2027-02-07', label: 'invoices[0]: ' },
      { supplierId: CFS, invoiceDate: '2026-11-10', dueDate: '2027-02-08', label: 'invoices[1]: ' },
      { supplierId: OTHER, invoiceDate: '2026-11-10', dueDate: '2026-12-10', label: 'invoices[2]: ' },
    ]);
    expect(w).toHaveLength(2);
    expect(w[0]!.startsWith('invoices[0]: ')).toBe(true);
    expect(w[1]!.startsWith('invoices[1]: ')).toBe(true);
    expect(contactTerms).toHaveBeenCalledTimes(2);
    expect(vi.mocked(contactTerms).mock.calls.every((c) => c[0] === COMPANY && c[1] === 'supplier')).toBe(true);
  });
});
