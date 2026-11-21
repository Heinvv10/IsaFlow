/**
 * The capped FIFO planner (#1701 round 5): a typed invoice takes what fits (L2), the note's own linked invoice is never
 * capped, each capacity is read once per walk and only for invoices the plan reaches, and the result equals a plan
 * over every capacity known up front.
 */
import { describe, expect, it } from 'vitest';
import { cappedDocuments, planWithinTypedCapacity, unreadCapacities } from '@/modules/accounting/services/shared/creditNoteTypedPlan';
import { planGreedyAllocations } from '@/modules/accounting/services/shared/autoAllocateStrategy';

const docs = [{ invoiceId: 'a', outstanding: 115 }, { invoiceId: 'b', outstanding: 115 }, { invoiceId: 'c', outstanding: 115 }];
const unlinked = { type: 'customer', customerInvoiceId: null };

describe('planWithinTypedCapacity', () => {
  it('a partly fitting typed invoice takes what fits, the rest goes on; capacities read once, only where reached', async () => {
    const reads: string[] = [];
    const caps: Record<string, number | null> = { a: 5750, b: null, c: 0 };
    const plan = await planWithinTypedCapacity(async (id) => { reads.push(id); return caps[id]!; }, unlinked, 115, docs, 0);
    expect(plan).toEqual([{ invoiceId: 'a', amount: 57.5 }, { invoiceId: 'b', amount: 57.5 }]);
    expect(reads).toEqual(['a', 'b']);
  });
  it('nothing left on the first: it is passed over (0 room), the cash goes to the next', async () => {
    const plan = await planWithinTypedCapacity(async (id) => (id === 'a' ? 0 : null), unlinked, 100, docs, 0);
    expect(plan).toEqual([{ invoiceId: 'b', amount: 100 }]);
  });
  it('the note\'s own linked invoice is never capped or read', async () => {
    const reads: string[] = [];
    const plan = await planWithinTypedCapacity(async (id) => { reads.push(id); return 0; }, { type: 'customer', customerInvoiceId: 'A' }, 100, docs, 0);
    expect(plan).toEqual([{ invoiceId: 'a', amount: 100 }]);
    expect(reads).toEqual([]);
  });
  it('equals a plan with every capacity known up front', async () => {
    const all = new Map<string, number | null>([['a', 1000], ['b', 2000], ['c', null]]);
    const known = planGreedyAllocations(300, cappedDocuments(docs, all, unlinked), 0);
    expect(await planWithinTypedCapacity(async (id) => all.get(id)!, unlinked, 300, docs, 0)).toEqual(known);
  });
});

describe('unreadCapacities', () => {
  it('lists planned invoices the note is gated on and not read yet', () => {
    expect(unreadCapacities([{ invoiceId: 'a' }, { invoiceId: 'b' }, { invoiceId: 'c' }], new Map([['b', null]]), { type: 'customer', customerInvoiceId: 'c' }))
      .toEqual(['a']);
  });
});
