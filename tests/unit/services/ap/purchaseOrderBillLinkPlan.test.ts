/** The link planner (pure): every rule of docs/design/mcp-po-bill-links.md decisions 2, 4, 6, 8 and 9, one case each. */
import { describe, expect, it } from 'vitest';
import { planLinks, type PlanInput } from '@/modules/accounting/services/ap/purchaseOrderBillLinkPlan';
import {
  isFullyBilled, type BillFacts, type ExistingLink, type LinkRequest, type PoFacts,
} from '@/modules/accounting/services/ap/purchaseOrderBillLinkTypes';

const SUP = 's1';
const po = (id: string, over: Partial<PoFacts> = {}): PoFacts => ({ id, poNumber: `PO-${id}`, status: 'approved', supplierId: SUP, subtotalCents: 30000, ...over });
const bill = (id: string, over: Partial<BillFacts> = {}): BillFacts => ({
  id, invoiceNumber: `B-${id}`, status: 'approved', supplierId: SUP, subtotalCents: 30000,
  lines: [{ id: `${id}-l1`, poItemId: null, poItemPoId: null, postedCents: 10000 }, { id: `${id}-l2`, poItemId: null, poItemPoId: null, postedCents: 20000 }], ...over,
});
const req = (index: number, poId: string, billId: string, over: Partial<LinkRequest> = {}): LinkRequest =>
  ({ index, poId, poNumber: null, billId, amountCents: null, lines: [], ref: null, ...over });
const existing = (over: Partial<ExistingLink> = {}): ExistingLink => ({
  id: 'x', poId: 'p1', billId: 'b1', billStatus: 'approved', amountCents: 10000, refSystem: null, refRef: null, closedFrom: null, ...over,
});

function plan(requests: LinkRequest[], over: Partial<PlanInput> = {}) {
  const pos = new Map([['p1', po('p1')], ['p2', po('p2')]]);
  const bills = new Map([['b1', bill('b1')], ['b2', bill('b2')]]);
  return planLinks({
    requests, resolvedPo: new Map(requests.filter((r) => r.poId).map((r) => [r.index, r.poId!])), pos, bills,
    poItemOwner: new Map([['i1', 'p1'], ['i2', 'p1'], ['j1', 'p2']]), existing: [], refOwners: new Map(), closeWhenFullyBilled: false, ...over,
  });
}
const reasons = (r: ReturnType<typeof plan>) => r.refusals.map((x) => `${x.index}:${x.reason}`);

describe('status and ownership', () => {
  it.each([['draft'], ['submitted'], ['cancelled']])('refuses a %s PO', (status) => {
    const r = plan([req(0, 'p1', 'b1')], { pos: new Map([['p1', po('p1', { status })]]) });
    expect(reasons(r)[0]).toContain(`is ${status}`);
  });
  it.each([['approved'], ['partially_received'], ['received'], ['closed']])('takes a %s PO', (status) => {
    expect(plan([req(0, 'p1', 'b1')], { pos: new Map([['p1', po('p1', { status })]]) }).plan).not.toBeNull();
  });
  it('refuses a cancelled bill, a missing PO or bill, and another supplier', () => {
    const r = plan([req(0, 'p1', 'b1'), req(1, 'p1', 'nope'), { ...req(2, 'p1', 'b2'), poId: null }, req(3, 'p2', 'b2')], {
      bills: new Map([['b1', bill('b1', { status: 'cancelled' })], ['b2', bill('b2', { supplierId: 'other' })]]),
    });
    expect(reasons(r)).toEqual([
      '0:bill B-b1 is cancelled; only an approved, paid or partially paid bill can be linked', '1:bill not found', '2:purchase order not found', '3:bill B-b2 and purchase order PO-p2 are of different suppliers',
    ]);
    expect(r.plan).toBeNull();
  });
  it('R3: only an approved, paid or partially_paid bill is linked; a draft, pending, disputed or cancelled one is refused with its status', () => {
    for (const status of ['draft', 'pending_approval', 'disputed', 'cancelled']) {
      expect(reasons(plan([req(0, 'p1', 'b1')], { bills: new Map([['b1', bill('b1', { status })]]) }))[0])
        .toBe(`0:bill B-b1 is ${status}; only an approved, paid or partially paid bill can be linked`);
    }
    for (const status of ['approved', 'paid', 'partially_paid']) {
      expect(plan([req(0, 'p1', 'b1')], { bills: new Map([['b1', bill('b1', { status })]]) }).plan).not.toBeNull();
    }
  });
});

describe('amount (decision 4)', () => {
  const amount = (r: ReturnType<typeof plan>, i = 0) => r.plan!.planned[i]!.amountCents;
  it('explicit wins', () => expect(amount(plan([req(0, 'p1', 'b1', { amountCents: 12345 })]))).toBe(12345));
  it('else the posted ex-VAT of the lines linked in the call', () => {
    expect(amount(plan([req(0, 'p1', 'b1', { lines: [{ poItemId: 'i2', billLineId: 'b1-l2' }] })]))).toBe(20000);
  });
  it('and of the lines already naming this PO', () => {
    const lines = [{ id: 'b1-l1', poItemId: 'i1', poItemPoId: 'p1', postedCents: 7000 }, { id: 'b1-l2', poItemId: null, poItemPoId: null, postedCents: 23000 }];
    expect(amount(plan([req(0, 'p1', 'b1')], { bills: new Map([['b1', bill('b1', { lines })]]) }))).toBe(7000);
  });
  it('else the subtotal less the bill\'s other links, existing and earlier in the call', () => {
    expect(amount(plan([req(0, 'p1', 'b1')]))).toBe(30000);
    expect(amount(plan([req(0, 'p1', 'b1')], { existing: [existing({ poId: 'p2', amountCents: 10000 })] }))).toBe(20000);
    const r = plan([req(0, 'p1', 'b1', { amountCents: 10000 }), req(1, 'p2', 'b1')]);
    expect(amount(r, 1)).toBe(20000);
  });
  // PR #1703 breaker BRK-C: lines that post nothing used to fall back to the subtotal, a link committed spend never nets (it nets
  // line-linked POs by their lines). With lines named, the link IS the lines' posted amount: R0 is refused.
  it('lines that post nothing are refused (the link would be the lines\' amount, R0)', () => {
    const lines = [{ id: 'b1-l1', poItemId: null, poItemPoId: null, postedCents: 0 }];
    const r = plan([req(0, 'p1', 'b1', { lines: [{ poItemId: 'i1', billLineId: 'b1-l1' }] })], {
      bills: new Map([['b1', bill('b1', { lines })]]), existing: [existing({ poId: 'p2', amountCents: 5000 })],
    });
    expect(reasons(r)[0]).toMatch(/^0:the bill lines named for purchase order PO-p1 post 0.00/);
  });
  // BRK-A: an explicit amount beside lines was taken as given, so the lines netted one figure and the link held another.
  it('an explicit amount beside lines must be the lines\' posted amount (within a cent), else refused', () => {
    const named = { lines: [{ poItemId: 'i2', billLineId: 'b1-l2' }] };
    expect(reasons(plan([req(0, 'p1', 'b1', { ...named, amountCents: 10000 })]))[0])
      .toBe('0:amount 100.00 is not what the bill lines named for purchase order PO-p1 post (200.00); send that amount, or no amount');
    expect(amount(plan([req(0, 'p1', 'b1', { ...named, amountCents: 20001 })]))).toBe(20000);
  });
  // BRK-B: one rand of a bill is attributed to at most one PO: a PO its lines name holds the lines' amount, whatever its link says.
  it('another PO the bill\'s lines name holds the lines\' amount, not its (stale) link amount', () => {
    const lines = [{ id: 'b1-l1', poItemId: 'j1', poItemPoId: 'p2', postedCents: 20000 }, { id: 'b1-l2', poItemId: null, poItemPoId: null, postedCents: 10000 }];
    const r = plan([req(0, 'p1', 'b1')], { bills: new Map([['b1', bill('b1', { lines })]]), existing: [existing({ poId: 'p2', amountCents: 5000 })] });
    expect(amount(r)).toBe(10000);
  });
  it('is refused at or below zero, and past the subtotal by more than a cent', () => {
    expect(reasons(plan([req(0, 'p1', 'b1')], { existing: [existing({ poId: 'p2', amountCents: 30000 })] }))[0]).toContain('give an amount above zero');
    expect(reasons(plan([req(0, 'p1', 'b1', { amountCents: 30002 })]))[0]).toContain('would pass it');
    expect(plan([req(0, 'p1', 'b1', { amountCents: 30001 })]).plan).not.toBeNull();
    const lines = [{ id: 'b1-l1', poItemId: null, poItemPoId: null, postedCents: 0 }];
    expect(reasons(plan([req(0, 'p1', 'b1', { lines: [{ poItemId: 'i1', billLineId: 'b1-l1' }] })], {
      bills: new Map([['b1', bill('b1', { lines, subtotalCents: 0 })]]),
    }))[0]).toContain('post 0.00');
  });
  it('two links of one bill past its subtotal: the second is refused', () => {
    const r = plan([req(0, 'p1', 'b1', { amountCents: 20000 }), req(1, 'p2', 'b1', { amountCents: 10002 })]);
    expect(reasons(r)).toEqual([expect.stringMatching(/^1:bill B-b1 has 300.00 ex VAT and 200.00 is already linked; 100.02 more would pass it/)]);
  });
});

describe('billed counts a header-only bill (no link row) as committed nets it', () => {
  it('a bill naming the PO only in its header adds its netted amount, unless this call links it', () => {
    const headerBilled = new Map([['p1', [{ billId: 'b2', cents: 20000 }]]]);
    const r = plan([req(0, 'p1', 'b1', { amountCents: 10000 })], { headerBilled, closeWhenFullyBilled: true });
    expect(r.plan!.poAfter.get('p1')).toMatchObject({ billedCents: 30000, fullyBilled: true, statusAfter: 'closed' });
    const relinked = plan([req(0, 'p1', 'b2', { amountCents: 20000 })], { headerBilled });
    expect(relinked.plan!.poAfter.get('p1')!.billedCents).toBe(20000);
  });
});

describe('idempotency (decision 9)', () => {
  const ref = { system: 'sage', ref: '7' };
  it('the same pair under the same reference is existing, not written', () => {
    const e = existing({ refSystem: 'sage', refRef: '7' });
    const r = plan([req(0, 'p1', 'b1', { ref })], { existing: [e] });
    expect(r.plan!.planned[0]).toMatchObject({ existing: e, lineWrites: [], closedFrom: null, amountCents: 10000 });
  });
  it('the same pair otherwise is refused (no reference sent, another reference stored)', () => {
    for (const [stored, sent] of [[{ refSystem: 'sage', refRef: '7' }, null], [{ refSystem: 'sage', refRef: '8' }, ref], [{ refSystem: 'sage', refRef: '8' }, null]] as const) {
      expect(reasons(plan([req(0, 'p1', 'b1', { ref: sent })], { existing: [existing(stored)] }))[0]).toContain('is already linked to purchase order PO-p1');
    }
    expect(reasons(plan([req(0, 'p1', 'b1')], { existing: [existing()] }))[0]).toContain('is already linked to purchase order PO-p1');
  });
  it('a ref-less link ADOPTS a reference sent with it (nothing else written)', () => {
    const e = existing();
    const r = plan([req(0, 'p1', 'b1', { ref })], { existing: [e] });
    expect(r.plan!.planned[0]).toMatchObject({ existing: e, adopt: true, lineWrites: [], closedFrom: null, amountCents: 10000 });
    expect(plan([req(0, 'p1', 'b1', { ref, amountCents: 10000 })], { existing: [e] }).plan!.planned[0]!.adopt).toBe(true);
  });
  it('payload_differs: the same reference or an adoption with another explicit amount or other lines is refused, not already_existed', () => {
    const same = existing({ refSystem: 'sage', refRef: '7' });
    expect(reasons(plan([req(0, 'p1', 'b1', { ref, amountCents: 9000 })], { existing: [same] }))[0])
      .toContain('payload_differs): amount 90.00 against 100.00 stored');
    expect(reasons(plan([req(0, 'p1', 'b1', { ref, amountCents: 9000 })], { existing: [existing()] }))[0]).toContain('payload_differs');
    const linked = bill('b1', { lines: [{ id: 'b1-l1', poItemId: 'i1', poItemPoId: 'p1', postedCents: 10000 }, { id: 'b1-l2', poItemId: null, poItemPoId: null, postedCents: 20000 }] });
    const bills = new Map([['b1', linked]]);
    expect(reasons(plan([req(0, 'p1', 'b1', { ref, lines: [{ poItemId: 'i2', billLineId: 'b1-l2' }] })], { existing: [same], bills }))[0]).toContain('the lines named are not the lines linked');
    const agree = plan([req(0, 'p1', 'b1', { ref, amountCents: 10000, lines: [{ poItemId: 'i1', billLineId: 'b1-l1' }] })], { existing: [same], bills });
    expect(agree.plan!.planned[0]).toMatchObject({ existing: same, adopt: false });
  });
  it('a reference already on another pair is refused, also for an adoption', () => {
    const r = plan([req(0, 'p1', 'b2', { ref })], { refOwners: new Map([['sage\u00007', existing()]]) });
    expect(reasons(r)[0]).toContain('external_ref 7 (sage) is already used by another purchase order link');
    const adopt = plan([req(0, 'p1', 'b1', { ref })], { existing: [existing()], refOwners: new Map([['sage\u00007', existing({ id: 'other' })]]) });
    expect(reasons(adopt)[0]).toContain('is already used by another purchase order link');
  });
  it('the same pair twice in a call is refused on the second', () => {
    expect(reasons(plan([req(0, 'p1', 'b1'), req(1, 'p1', 'b1')]))).toEqual(['1:the same purchase order and bill as links[0]']);
  });
});

describe('line links (decision 2)', () => {
  const line = (poItemId: string, billLineId: string) => ({ poItemId, billLineId });
  it('writes the po_item_id of each named line', () => {
    const r = plan([req(0, 'p1', 'b1', { lines: [line('i1', 'b1-l1'), line('i2', 'b1-l2')] })]);
    expect(r.plan!.planned[0]).toMatchObject({ linesLinked: 2, lineWrites: [line('i1', 'b1-l1'), line('i2', 'b1-l2')], amountCents: 30000 });
  });
  it('a PO line of another PO, a line of another bill, one named twice: refused', () => {
    expect(reasons(plan([req(0, 'p1', 'b1', { lines: [line('j1', 'b1-l1')] })]))[0]).toContain('purchase order line j1 is not a line of purchase order PO-p1');
    expect(reasons(plan([req(0, 'p1', 'b1', { lines: [line('i1', 'b2-l1')] })]))[0]).toContain('is not a line of bill B-b1');
    const r = plan([req(0, 'p1', 'b1', { lines: [line('i1', 'b1-l1')], amountCents: 10000 }), req(1, 'p2', 'b1', { lines: [line('j1', 'b1-l1')], amountCents: 100 })]);
    expect(reasons(r)).toEqual(['1:bill line b1-l1 is also named by links[0]']);
  });
  it('a bill line already naming ANOTHER PO line is refused; naming the same one is fine and not rewritten', () => {
    const named = (poItemId: string) => bill('b1', { lines: [{ id: 'b1-l1', poItemId, poItemPoId: 'p1', postedCents: 30000 }] });
    expect(reasons(plan([req(0, 'p1', 'b1', { lines: [line('i1', 'b1-l1')] })], { bills: new Map([['b1', named('i2')]]) }))[0]).toContain('already names another purchase order line');
    const same = plan([req(0, 'p1', 'b1', { lines: [line('i1', 'b1-l1')] })], { bills: new Map([['b1', named('i1')]]) });
    expect(same.plan!.planned[0]).toMatchObject({ lineWrites: [], linesLinked: 1 });
  });
});

describe('billed and close_when_fully_billed (decisions 5 and 6)', () => {
  const after = (r: ReturnType<typeof plan>, id = 'p1') => r.plan!.poAfter.get(id)!;
  it('fully billed is within one cent of the subtotal', () => {
    expect(isFullyBilled(29999, 30000)).toBe(true);
    expect(isFullyBilled(29998, 30000)).toBe(false);
  });
  it('billed counts links on approved / paid / partially_paid bills only, existing and new', () => {
    const r = plan([req(0, 'p1', 'b1', { amountCents: 10000 })], { existing: [
      existing({ id: 'a', billId: 'x1', billStatus: 'paid', amountCents: 5000 }), existing({ id: 'b', billId: 'x2', billStatus: 'draft', amountCents: 9000 }),
      existing({ id: 'c', billId: 'x3', billStatus: 'cancelled', amountCents: 9000 }), existing({ id: 'd', billId: 'x4', billStatus: 'deleted', amountCents: 9000 }),
    ] });
    expect(after(r)).toMatchObject({ billedCents: 15000, fullyBilled: false });
    const paid = plan([req(0, 'p1', 'b1')], { bills: new Map([['b1', bill('b1', { status: 'paid' })]]) });
    expect(after(paid)).toMatchObject({ billedCents: 30000, fullyBilled: true });
  });
  it('closes only with the flag, only from approved / partially_received / received, and the LAST new link records the status', () => {
    const two = [req(0, 'p1', 'b1', { amountCents: 10000 }), req(1, 'p1', 'b2', { amountCents: 20000 })];
    const noFlag = plan(two);
    expect(after(noFlag)).toMatchObject({ statusAfter: 'approved', fullyBilled: true });
    expect(noFlag.plan!.planned.map((p) => p.closedFrom)).toEqual([null, null]);
    const flag = plan(two, { closeWhenFullyBilled: true, pos: new Map([['p1', po('p1', { status: 'received' })]]) });
    expect(after(flag)).toMatchObject({ statusBefore: 'received', statusAfter: 'closed' });
    expect(flag.plan!.planned.map((p) => p.closedFrom)).toEqual([null, 'received']);
    const closed = plan(two, { closeWhenFullyBilled: true, pos: new Map([['p1', po('p1', { status: 'closed' })]]) });
    expect(after(closed).statusAfter).toBe('closed');
    expect(closed.plan!.planned.map((p) => p.closedFrom)).toEqual([null, null]);
  });
  it('an already_existed row alone never closes a PO', () => {
    const r = plan([req(0, 'p1', 'b1', { ref: { system: 'sage', ref: '1' } })], {
      closeWhenFullyBilled: true, existing: [existing({ amountCents: 30000, refSystem: 'sage', refRef: '1' })],
    });
    expect(after(r)).toMatchObject({ statusAfter: 'approved', fullyBilled: true });
    expect(r.plan!.planned[0]!.closedFrom).toBeNull();
  });
});
