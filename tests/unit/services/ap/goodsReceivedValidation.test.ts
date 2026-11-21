/**
 * parseGoodsReceived's quantity rule (gate round 5 nit on #1697): a quantity must fit grn_items' NUMERIC(15,2), at most
 * 9999999999999.99, so an oversized one is a typed input refusal (GoodsReceivedError 'invalid') and never a 22003 from the insert.
 */
import { describe, expect, it } from 'vitest';
import { GRN_QUANTITY_MAX, GoodsReceivedError, parseGoodsReceived } from '@/modules/accounting/services/ap/goodsReceivedValidation';

const PO = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const input = (line: Record<string, unknown>) => ({ purchaseOrderId: PO, receivedDate: '2026-06-20', items: [{ poItemId: LINE, ...line }] });
const refusal = (line: Record<string, unknown>) => {
  try { parseGoodsReceived(input(line), 'u1'); } catch (err) { return err; }
  return null;
};

describe('parseGoodsReceived requires quantityReceived on every line (review of fba543d5, finding 2: the app POST path)', () => {
  it.each([
    ['omitted', { quantityRejected: 2 }],
    ['null', { quantityReceived: null, quantityRejected: 2 }],
    ['empty', { quantityReceived: '', quantityRejected: 2 }],
    // Whitespace only is missing too, not Number('  ') = 0 (Codex gate at 4840b1a6, nit 2).
    ['whitespace only', { quantityReceived: '  ', quantityRejected: 2 }],
    ['a tab and a newline', { quantityReceived: '\t\n', quantityRejected: 2 }],
  ])('refuses it %s, typed, even on a rejection-only line', (_, line) => {
    const err = refusal(line);
    expect(err).toBeInstanceOf(GoodsReceivedError);
    expect((err as GoodsReceivedError).refusal).toBe('invalid');
    expect((err as GoodsReceivedError).message).toContain('received quantity is required');
  });

  it('accepts an explicit 0 on a rejection-only line; an omitted quantityRejected is still 0', () => {
    expect(parseGoodsReceived(input({ quantityReceived: 0, quantityRejected: 2 }), 'u1').items[0]).toMatchObject({ quantityReceived: 0, quantityRejected: 2 });
    expect(parseGoodsReceived(input({ quantityReceived: 3 }), 'u1').items[0]).toMatchObject({ quantityReceived: 3, quantityRejected: 0 });
  });
});

describe('parseGoodsReceived quantities', () => {
  it('the storage maximum is NUMERIC(15,2)\'s', () => {
    expect(GRN_QUANTITY_MAX).toBe(9999999999999.99);
  });

  it('accepts both quantities at the maximum', () => {
    expect(parseGoodsReceived(input({ quantityReceived: GRN_QUANTITY_MAX, quantityRejected: GRN_QUANTITY_MAX }), 'u1').items[0])
      .toMatchObject({ quantityReceived: GRN_QUANTITY_MAX, quantityRejected: GRN_QUANTITY_MAX });
  });

  it.each([
    ['quantityRejected', { quantityReceived: 1, quantityRejected: 10000000000000 }],
    ['quantityReceived', { quantityReceived: 10000000000000 }],
    ['quantityReceived as a string', { quantityReceived: '10000000000000' }],
  ])('refuses %s above it, typed', (_, line) => {
    const err = refusal(line);
    expect(err).toBeInstanceOf(GoodsReceivedError);
    expect((err as GoodsReceivedError).refusal).toBe('invalid');
    expect((err as GoodsReceivedError).message).toContain('9999999999999.99');
  });
});
