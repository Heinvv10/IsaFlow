/**
 * Intercompany F: suggestion ranking is PURE over the receiver's own rows and the payload (amount, date, reference text): the linked issuer
 * invoice first, then the customer's other open invoices oldest first; receipts and bank lines by the bank matcher's own scores (amount,
 * date, description), ties by date then id. The draft is refused while an exact candidate exists (Q2 / MED-2).
 */
import { describe, expect, it } from 'vitest';
import { draftRefusal, orderInvoices, rankBankLines, rankReceipts } from '@/modules/accounting/services/intercompany/paymentRanking';

const P = { amount: 1150, date: '2026-09-01', reference: 'INV 100 ACME', number: 'SP-9' };

describe('orderInvoices', () => {
  it('puts the linked invoice first and marks it; the rest oldest first, then by id', () => {
    const out = orderInvoices('l', [
      { id: 'b', number: 'B', date: '2026-08-01', openAmount: 10 },
      { id: 'l', number: 'L', date: '2026-09-01', openAmount: 1150 },
      { id: 'a', number: 'A', date: '2026-08-01', openAmount: 10 },
      { id: 'c', number: 'C', date: '2026-07-01', openAmount: 10 },
    ]);
    expect(out.map((i) => i.id)).toEqual(['l', 'c', 'a', 'b']);
    expect(out.map((i) => i.linked)).toEqual([true, false, false, false]);
  });

  it('works when the linked invoice is not open (absent)', () => {
    expect(orderInvoices('x', [{ id: 'a', number: 'A', date: null, openAmount: 1 }]).map((i) => i.linked)).toEqual([false]);
  });
});

describe('rankReceipts', () => {
  const r = (id: string, over: Partial<Parameters<typeof rankReceipts>[1][number]> = {}) => ({
    id, number: id, date: '2026-09-01', total: 1150, allocated: 0, consumed: 0, onLinkedInvoice: false, text: '', ...over,
  });
  it('an exact unallocated receipt on the payment date scores highest; remainders are reported', () => {
    const out = rankReceipts(P, [r('far', { date: '2026-10-30' }), r('exact'), r('big', { total: 5000 })]);
    expect(out[0]!.id).toBe('exact');
    expect(out[0]).toMatchObject({ unallocated: 1150, unconsumed: 1150, exact: true });
    expect(out.find((x) => x.id === 'big')).toMatchObject({ unallocated: 5000, exact: false });
  });

  it('a reference word in common lifts a receipt; ties go by date then id', () => {
    const out = rankReceipts(P, [r('b'), r('a'), r('words', { text: 'payment ACME inv 100' })]);
    expect(out.map((x) => x.id)).toEqual(['words', 'a', 'b']);
  });

  it('consumption: what accepted messages already took is not offered again', () => {
    const [x] = rankReceipts(P, [r('c', { total: 2300, consumed: 1150 })]);
    expect(x).toMatchObject({ unconsumed: 1150, exact: true });
  });
});

describe('draftRefusal', () => {
  const base = { id: 'x', number: 'x', date: '2026-09-01', total: 1150, unallocated: 1150, unconsumed: 1150, exact: true, onLinkedInvoice: false, score: 1 };
  it('refuses while a candidate is exact or holds an allocation on the linked invoice; else null', () => {
    expect(draftRefusal([base])).toBe('exact_receipt');
    expect(draftRefusal([{ ...base, exact: false, onLinkedInvoice: true }])).toBe('linked_receipt');
    expect(draftRefusal([{ ...base, exact: false }])).toBeNull();
    expect(draftRefusal([])).toBeNull();
  });
});

describe('rankBankLines', () => {
  it('scores by amount, date and description; best first; a hint carries no action', () => {
    const out = rankBankLines(P, [
      { id: 'off', date: '2026-09-01', amount: 900, description: 'x' },
      { id: 'on', date: '2026-09-02', amount: 1150, description: 'ACME INV 100' },
    ]);
    expect(out.map((l) => l.id)).toEqual(['on', 'off']);
    expect(Object.keys(out[0]!).sort()).toEqual(['amount', 'date', 'description', 'id', 'score']);
  });
});
