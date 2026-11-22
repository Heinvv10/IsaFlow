/**
 * The bulk dry run's FIFO preview (#1701 round 11, major 3) reads an open invoice's credit history only as the walk
 * reaches it, in FIFO order, and stops once the note's credit is used up (it read every open invoice's for every note).
 * The plan is the same as over every invoice: pinned on a batch whose later linked note depends on where an earlier
 * standalone note landed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OPEN = ['inv-1', 'inv-2', 'inv-3', 'inv-4'];
const h = vi.hoisted(() => ({ notes: [] as Record<string, unknown>[], reads: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[]) => {
    const text = strings.join('?');
    if (/FROM credit_notes/.test(text)) return h.notes;
    if (/FROM customer_invoices/.test(text)) return [{ status: 'approved', outstanding: '115.00' }];
    return [];
  }),
}));
// Every invoice typed: one standard leg of 100, VAT 15, nothing applied.
vi.mock('@/modules/accounting/services/ar/invoiceRevenuePosting', () => ({
  invoiceCreditFigures: vi.fn(async (_c: string, id: string) => {
    h.reads.push(id);
    return { legs: [{ glAccountId: 'rev', projectId: null, cc1Id: null, cc2Id: null, buId: null, net: 100, taken: 0, journalLineId: `jl-${id}`, vatType: 'standard' }],
      replayed: [], typed: { vatLeft: 1500, applied: 0 } };
  }),
}));
vi.mock('@/modules/accounting/services/ar/openCustomerInvoices', () => ({
  fetchOpenCustomerInvoices: vi.fn(async () => OPEN.map((invoiceId) => ({ invoiceId, invoiceNumber: invoiceId, outstanding: 115 }))),
}));

import { simulateBatchApprovals } from '@/modules/accounting/services/shared/creditNoteBatchSimulation';

const note = (id: string, over: Record<string, unknown>) => ({
  id, type: 'customer', linked: null, client_id: 'cust', credit_note_number: id, subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00', ...over,
});
beforeEach(() => { h.reads = []; });

describe('simulateBatchApprovals reads lazily, in FIFO order', () => {
  it('a standalone 115 note reads the first open invoice only (it covers it), not all four', async () => {
    h.notes = [note('S', {})];
    expect((await simulateBatchApprovals('co', ['S'], 'fifo')).size).toBe(0);
    expect(h.reads).toEqual(['inv-1']);
  });
  it('230 reads two; the plan is the same: a later linked note on inv-2 then has nothing left (refused), one on inv-3 posts', async () => {
    h.notes = [note('S', { subtotal: '200.00', tax_amount: '30.00', total_amount: '230.00' }),
      note('L2', { linked: 'inv-2' }), note('L3', { linked: 'inv-3' })];
    const out = await simulateBatchApprovals('co', ['S', 'L2', 'L3'], 'fifo');
    expect([...out.keys()]).toEqual(['L2']);
    expect(out.get('L2')).toMatch(/has 0\.00 left to credit/);
    expect(h.reads.slice(0, 2)).toEqual(['inv-1', 'inv-2']);
    expect(h.reads).not.toContain('inv-4');
  });
});
