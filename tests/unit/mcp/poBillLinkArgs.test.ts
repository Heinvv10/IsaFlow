/** link_bills_to_purchase_order / unlink_bill_from_purchase_order arguments: parsed with no I/O, every bad element listed. */
import { describe, expect, it } from 'vitest';
import { parseLinkBatch, parsePoSelector } from '@/lib/mcp/tools/poBillLinkArgs';

const PO = '11111111-1111-4111-8111-111111111111';
const BILL = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const LINE = '44444444-4444-4444-8444-444444444444';

const refusals = (raw: unknown) => {
  const r = parseLinkBatch(raw);
  if (typeof r === 'string' || !('refusals' in r)) throw new Error(`expected refusals, got ${JSON.stringify(r)}`);
  return r.refusals;
};

describe('parseLinkBatch', () => {
  it('parses po_id and po_number links, lines, amount in cents and a reference (a numeric Sage id, system lowered)', () => {
    const r = parseLinkBatch([
      { po_id: PO.toUpperCase(), bill_id: BILL, amount: 12.34, lines: [{ po_item_id: ITEM, bill_line_id: LINE }], external_system: 'Sage', external_ref: 4711 },
      { po_number: ' PO0000197 ', bill_id: BILL },
    ]);
    expect(r).toEqual({ links: [
      { index: 0, poId: PO, poNumber: null, billId: BILL, amountCents: 1234, lines: [{ poItemId: ITEM, billLineId: LINE }], ref: { system: 'sage', ref: '4711' } },
      { index: 1, poId: null, poNumber: 'PO0000197', billId: BILL, amountCents: null, lines: [], ref: null },
    ] });
  });

  it('refuses a non-array, an empty array and more than 200 links', () => {
    expect(parseLinkBatch(undefined)).toBe('links must be a non-empty array');
    expect(parseLinkBatch([])).toBe('links must be a non-empty array');
    expect(parseLinkBatch(Array.from({ length: 201 }, () => ({ po_id: PO, bill_id: BILL })))).toMatch(/^links has 201 elements; the maximum is 200/);
  });

  it('lists EVERY bad element with its index, not only the first', () => {
    expect(refusals([
      { po_id: PO, bill_id: BILL },
      { bill_id: BILL },
      { po_id: PO, po_number: 'PO1', bill_id: BILL },
      { po_id: 'nope', bill_id: BILL },
      { po_id: PO, bill_id: 'nope' },
      { po_id: PO, bill_id: BILL, amount: 0 },
      { po_id: PO, bill_id: BILL, amount: 1.005 },
      { po_id: PO, bill_id: BILL, amount: '5' },
      { po_id: PO, bill_id: BILL, lines: [] },
      { po_id: PO, bill_id: BILL, lines: [{ po_item_id: ITEM }] },
      { po_id: PO, bill_id: BILL, lines: [{ po_item_id: ITEM, bill_line_id: LINE }, { po_item_id: ITEM, bill_line_id: LINE }] },
      { po_id: PO, bill_id: BILL, lines: [{ po_item_id: ITEM, bill_line_id: LINE, qty: 1 }] },
      { po_id: PO, bill_id: BILL, external_ref: 'x' },
      { po_id: PO, bill_id: BILL, external_system: 'sage' },
      { po_id: PO, bill_id: BILL, company_id: 'x' },
      'x',
    ]).map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('words each refusal for the agent', () => {
    const [a, b, c, d, e] = refusals([
      { bill_id: BILL },
      { po_id: PO, bill_id: 'nope' },
      { po_id: PO, bill_id: BILL, amount: -1 },
      { po_id: PO, bill_id: BILL, company_id: 'x' },
      { po_id: PO, bill_id: BILL, external_ref: 'x' },
    ]);
    expect(a!.reason).toBe('give exactly one of po_id and po_number');
    expect(b!.reason).toBe('bill_id must be a supplier invoice UUID');
    expect(c!.reason).toBe('amount must be a number above zero');
    expect(d!.reason).toContain('company_id is not a field of this tool');
    expect(e!.reason).toContain('external_system is required with external_ref');
  });

  it('a reference named twice is refused; the same pair named twice is left to the planner (it may be an id and a number)', () => {
    const dup = refusals([
      { po_id: PO, bill_id: BILL, external_system: 'sage', external_ref: '1' },
      { po_id: PO, bill_id: ITEM, external_system: 'SAGE', external_ref: '1' },
    ]);
    expect(dup).toEqual([{ index: 1, reason: 'external_ref 1 is also links[0]' }]);
    const pair = parseLinkBatch([{ po_id: PO, bill_id: BILL }, { po_id: PO, bill_id: BILL }]);
    expect(pair).toMatchObject({ links: [{ index: 0 }, { index: 1 }] });
  });
});

describe('parsePoSelector', () => {
  it('takes exactly one of po_id and po_number', () => {
    expect(parsePoSelector({ po_id: PO }, 'x')).toEqual({ poId: PO, poNumber: null });
    expect(parsePoSelector({ po_number: 'PO1' }, 'x')).toEqual({ poId: null, poNumber: 'PO1' });
    expect(parsePoSelector({}, 'x')).toBe('x: give exactly one of po_id and po_number');
    expect(parsePoSelector({ po_number: 'P'.repeat(51) }, 'x')).toContain('at most 50 characters');
  });
});
