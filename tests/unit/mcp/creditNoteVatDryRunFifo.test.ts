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
// Typed invoice X: one standard leg of net 100, VAT 15, nothing applied.
const h2 = vi.hoisted(() => ({ legs: (): unknown[] => [{ glAccountId: 'rev', projectId: null, cc1Id: null, cc2Id: null, buId: null, net: 100, taken: 0, journalLineId: 'jl-1', vatType: 'standard' }] }));
vi.mock('@/modules/accounting/services/ar/invoiceRevenuePosting', () => ({
  invoiceCreditFigures: vi.fn(async () => ({ legs: h2.legs(), replayed: [], typed: { vatLeft: 1500, applied: 0 } })),
}));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({
  fetchOpenCustomerInvoices: vi.fn(async () => [{ invoiceId: X, invoiceNumber: 'INV-1', outstanding: 115 }]),
}));

import { invoiceCreditFigures } from '@/modules/accounting/services/ar/invoiceRevenuePosting';
import { proportionalVatRefusals } from '@/lib/mcp/tools/creditNoteVatDryRun';
import { allocateTypedCreditNote, settleApplied } from '@/modules/accounting/services/ar/creditNoteTypedSplit';
import type { RevenueLeg } from '@/modules/accounting/services/ar/invoiceRevenueLines';

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

describe('the simulation is the live maths (#1701 round 9: one copy), a negative discount leg included', () => {
  const leg = (id: string, net: number, taken = 0): RevenueLeg => ({ glAccountId: 'rev', projectId: null, cc1Id: null, cc2Id: null, buId: null, net, taken, journalLineId: id, vatType: 'standard' });
  const NEG = () => [leg('jl-1', 100, 30), leg('jl-2', -20, -6)];            // net 80, a linked note already took 24 of it
  /** What the live approval would say of a linked note of s / tax after `applied` (cents) counted: its own functions. */
  const live = (applied: number, s: number, tax: number): string | null => {
    const now = settleApplied(NEG(), [], 840, applied);
    try { allocateTypedCreditNote(now.legs, { subtotal: s, taxAmount: tax, remainingVat: now.remainingVat / 100 }, 'L', 'x'); return null; } catch (err) { return (err as Error).message; }
  };
  it.each([
    ['nothing applied, a note of the whole remainder', 0, 56, 8.4],
    ['46 applied first (a standalone 40 + 6), a note of 30 + 4.50', 0, 30, 4.5],
    ['46 applied first, a note of 16 + 2.40', 0, 16, 2.4],
  ])('%s: the dry run refuses exactly when the live approval would', async (_l, applied, subtotal, tax) => {
    h2.legs = NEG;
    const standalone = _l.startsWith('46');
    h.notes = [...(standalone ? [note('S', { subtotal: '40.00', tax_amount: '6.00', total_amount: '46.00' })] : []),
      note('L', { linked: X, subtotal: subtotal.toFixed(2), tax_amount: tax.toFixed(2), total_amount: (subtotal + tax).toFixed(2) })];
    vi.mocked(invoiceCreditFigures).mockResolvedValue({ legs: NEG(), replayed: [], typed: { vatLeft: 840, applied } } as never);
    const out = await proportionalVatRefusals('co', standalone ? ['S', 'L'] : ['L'], 'fifo');
    const expected = live(standalone ? applied + 4600 : applied, subtotal, tax);
    expect(out.get('L') ?? null).toBe(expected === null ? null : `vat_split_refused: ${expected}`);
  });
});
