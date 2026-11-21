/**
 * bulk_approve_credit_notes' dry run, #1701 round 8 item 7 (the gate fixer's cases, on the kept simulation,
 * shared/creditNoteBatchSimulation): with auto_apply 'fifo' a standalone note earlier in the batch settles the only open
 * typed invoice before a later note linked to it is approved; the preview foresees the refusal the live run meets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const X = 'aaaaaaaa-0000-4000-8000-00000000000a';
const h = vi.hoisted(() => ({ notes: [] as Record<string, unknown>[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[]) => {
    const text = strings.join('?');
    if (/FROM credit_notes/.test(text)) return h.notes;
    if (/FROM customer_invoices/.test(text)) return [{ status: 'approved', outstanding: '115.00' }];
    return [];
  }),
}));
// Typed invoice X: net 100 on its legs, VAT 15, nothing applied.
vi.mock('@/modules/accounting/services/ar/invoiceRevenuePosting', () => ({
  invoiceCreditFigures: vi.fn(async () => ({ carries: [10000], typed: { vat: 1500, applied: 0 } })),
}));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({
  fetchOpenCustomerInvoices: vi.fn(async () => [{ invoiceId: X, invoiceNumber: 'INV-1', outstanding: 115 }]),
}));

import { proportionalVatRefusals } from '@/lib/mcp/tools/creditNoteVatDryRun';

const note = (id: string, over: Record<string, unknown>) => ({
  id, type: 'customer', linked: null, client_id: 'cust', credit_note_number: id, subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00', ...over,
});
beforeEach(() => { h.notes = [note('S', {}), note('L', { linked: X })]; });

describe('proportionalVatRefusals simulates what the batch\'s approvals apply', () => {
  it('a standalone note settling the typed invoice first leaves the linked note nothing to credit', async () => {
    const out = await proportionalVatRefusals('co', ['S', 'L'], 'fifo');
    expect([...out.keys()]).toEqual(['L']);
    expect(out.get('L')).toMatch(/^vat_split_refused: Credit note L credits 100\.00, but the invoice has 0\.00 left to credit/);
  });
  it('auto_apply "none" applies nothing, so the linked note still posts', async () => {
    expect((await proportionalVatRefusals('co', ['S', 'L'], 'none')).size).toBe(0);
  });
  it('the linked note first: it posts, and the standalone note after it is not refused', async () => {
    expect((await proportionalVatRefusals('co', ['L', 'S'], 'fifo')).size).toBe(0);
  });
  it('a standalone 40 + 6 first leaves 60 / 9: a linked 100 is refused naming 60.00', async () => {
    h.notes = [note('S', { subtotal: '40.00', tax_amount: '6.00', total_amount: '46.00' }), note('L', { linked: X })];
    expect((await proportionalVatRefusals('co', ['S', 'L'], 'fifo')).get('L')).toMatch(/has 60\.00 left to credit/);
  });
});
