/**
 * Breaker r6 A2 / review r6 L4: billedLinesByPoItem drops a bill's postings to a PO only when they sum below 0 across that PO (the
 * billAttribution floor), never per line: +500 / -500 on two lines of one PO are kept.
 */
import { describe, expect, it, vi } from 'vitest';

const { queue } = vi.hoisted(() => ({ queue: [] as unknown[][] }));
vi.mock('@/lib/neon', () => {
  const sql = Object.assign(vi.fn(async () => queue.shift() ?? []), { unsafe: vi.fn(() => '') });
  return { sql };
});
vi.mock('@/modules/accounting/services/budgets/postedExpenseLines', () => ({
  NO_ACCOUNT: 'unused',
  postedExpenseLines: (_b: unknown, items: Array<{ id: string; line_total: number }>) =>
    items.map((i) => ({ description: i.id, debit: i.line_total, glAccountId: 'g1', cc1Id: null, cc2Id: null, buId: null })),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowRow', () => ({ mapInvoiceRow: () => ({ invoiceDate: '2026-06-15' }) }));

import { billedLinesByPoItem } from '@/modules/accounting/services/budgets/remainingCommitted';

const item = (id: string, bill: string, po: string, poItem: string, total: number) =>
  ({ id, supplier_invoice_id: bill, po_item_id: poItem, item_po: po, line_total: total });
const sums = (m: Map<string, Array<{ amount: number }>>) => Object.fromEntries([...m].map(([k, v]) => [k, v.reduce((s, p) => s + p.amount, 0)]));

describe('billedLinesByPoItem floor', () => {
  it('breaker r8: +500 / -500 on two lines of one PO bill it nothing (net 0), so nothing is released', async () => {
    queue.push([{ id: 'b1' }], [item('l1', 'b1', 'P', 'a', 500), item('l2', 'b1', 'P', 'b', -500)]);
    expect(sums(await billedLinesByPoItem('c1', ['a', 'b'], []))).toEqual({});
  });
  it('breaker r8 / r9: line nets first, the PO net spread over the positive line nets by largest remainder; a negative line takes nothing', async () => {
    queue.push([{ id: 'b1' }], [item('l1', 'b1', 'P', 'a', 300), item('l2', 'b1', 'P', 'b', 100), item('l3', 'b1', 'P', 'c', -200)]);
    expect(sums(await billedLinesByPoItem('c1', ['a', 'b', 'c'], []))).toEqual({ a: 150, b: 50 });
    queue.push([{ id: 'b1' }], [item('l1', 'b1', 'P', 'a', -200), item('l2', 'b1', 'P', 'b', 300)]);
    expect(sums(await billedLinesByPoItem('c1', ['a', 'b'], []))).toEqual({ b: 100 });
    queue.push([{ id: 'b1' }], [item('l1', 'b1', 'P', 'a', 1), item('l2', 'b1', 'P', 'b', 1), item('l3', 'b1', 'P', 'c', 1), item('l4', 'b1', 'P', 'd', -1)]);
    expect(sums(await billedLinesByPoItem('c1', ['a', 'b', 'c'], []))).toEqual({ a: 0.67, b: 0.67, c: 0.66 }); // largest remainder (breaker r9)
    // Breaker r9: a credit on B stays on B (lines netted first): A +500, B +500 and -450 -> A 500, B 50.
    queue.push([{ id: 'b1' }], [item('l1', 'b1', 'P', 'a', 500), item('l2', 'b1', 'P', 'b', 500), item('l3', 'b1', 'P', 'b', -450)]);
    expect(sums(await billedLinesByPoItem('c1', ['a', 'b'], []))).toEqual({ a: 500, b: 50 });
  });
  it('drops a bill whose postings to a PO sum below 0 (a discount naming its line)', async () => {
    queue.push([{ id: 'b1' }], [item('l1', 'b1', 'P', 'a', -50)]);
    expect(sums(await billedLinesByPoItem('c1', ['a'], []))).toEqual({});
  });
  it('review r7 M1: the verdict is over every line of the bill naming the PO, whatever subset is asked for', async () => {
    const lines = () => [item('l1', 'b1', 'P', 'a', 300), item('l2', 'b1', 'P', 'b', -400)]; // A +300 (account X), B -400 (Y): -100
    for (const ask of [['a'], ['b'], ['a', 'b']]) {
      queue.push([{ id: 'b1' }], lines());
      expect(sums(await billedLinesByPoItem('c1', ask, [])), ask.join()).toEqual({});
    }
  });
  it('judges each PO of the bill on its own', async () => {
    queue.push([{ id: 'b1' }], [item('l1', 'b1', 'P', 'a', 300), item('l2', 'b1', 'Q', 'q', -100)]);
    expect(sums(await billedLinesByPoItem('c1', ['a', 'q'], []))).toEqual({ a: 300 });
  });
});
