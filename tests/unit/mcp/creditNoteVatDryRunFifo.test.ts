/**
 * bulk_approve_credit_notes' dry run, #1701 review round 8: with auto_apply 'fifo' a standalone note earlier in the
 * batch can settle the only open typed invoice before a later note linked to it is approved. The preview must foresee
 * the linked note's refusal the live run meets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/invoiceRevenuePosting', () => ({ typedInvoiceCreditState: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({ fetchOpenCustomerInvoices: vi.fn() }));

import { sql } from '@/lib/neon';
import { typedInvoiceCreditState } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { fetchOpenCustomerInvoices } from '@/modules/accounting/services/ar/openCustomerInvoices';
import { proportionalVatRefusals } from '@/lib/mcp/tools/creditNoteVatDryRun';

const X = 'aaaaaaaa-0000-4000-8000-00000000000a';
const note = (id: string, over: Record<string, unknown>) => ({
  id, type: 'customer', customer_invoice_id: null, client_id: 'cust', credit_note_number: id,
  subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00', ...over,
});

beforeEach(() => {
  vi.mocked(sql).mockReset();
  // Typed invoice X: R100 + R15 left, R115 open.
  vi.mocked(typedInvoiceCreditState).mockResolvedValue({ remainingNet: 100, remainingVat: 15 });
  vi.mocked(fetchOpenCustomerInvoices).mockResolvedValue([{ invoiceId: X, invoiceNumber: 'INV-1', outstanding: 115 }] as never);
  vi.mocked(sql).mockResolvedValue([note('S', {}), note('L', { customer_invoice_id: X })] as never);
});

describe('proportionalVatRefusals walks the batch\'s FIFO applications', () => {
  it('a standalone note settling the typed invoice first leaves the linked note nothing to credit', async () => {
    const out = await proportionalVatRefusals('co', ['S', 'L'], 'fifo');
    expect([...out.keys()]).toEqual(['L']);
    expect(out.get('L')).toMatch(/has 0\.00 left to credit/);
  });

  it('auto_apply "none" applies nothing, so the linked note still posts', async () => {
    expect((await proportionalVatRefusals('co', ['S', 'L'], 'none')).size).toBe(0);
  });

  it('the linked note first: it posts, and the standalone note after it is not judged', async () => {
    expect((await proportionalVatRefusals('co', ['L', 'S'], 'fifo')).size).toBe(0);
  });
});
