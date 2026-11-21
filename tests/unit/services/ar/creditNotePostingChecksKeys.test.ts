/** lockInvoicesCreditNotes: one key per invoice, in id order, so two walks over one customer take them alike. */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({
  fetchOpenCustomerInvoices: vi.fn(async () => [{ invoiceId: 'B-2' }, { invoiceId: 'a-1' }]),
}));

import { sql } from '@/lib/neon';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { lockInvoicesCreditNotes, lockOpenInvoicesCreditNotes } from '@/modules/accounting/services/ar/creditNotePostingChecks';

const keys = (): unknown[] => vi.mocked(sql).mock.calls.map((c) => c[1]);

describe('the credit-note keys of several invoices', () => {
  it('takes each once, lower-cased, in id order', async () => {
    vi.mocked(sql).mockClear();
    await lockInvoicesCreditNotes(['c-3', 'A-1', 'b-2', 'a-1']);
    expect(keys()).toEqual(['a-1', 'b-2', 'c-3'].map((id) => `isaflow.credit_note_approve.invoice:${id}`));
  });

  it('a customer\'s open invoices, read without row locks', async () => {
    vi.mocked(sql).mockClear();
    await lockOpenInvoicesCreditNotes('co', 'cust');
    expect(fetchOpenCustomerInvoices).toHaveBeenCalledWith('co', 'cust', true, { forUpdate: false });
    expect(keys()).toEqual(['a-1', 'b-2'].map((id) => `isaflow.credit_note_approve.invoice:${id}`));
  });
});
