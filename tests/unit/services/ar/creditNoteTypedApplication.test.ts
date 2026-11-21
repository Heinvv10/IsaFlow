/**
 * The typed-invoice apply gate (#1701 rounds 4-5), on a mocked state: the increment against the CURRENT capacity
 * (net + VAT left, the note's own row counted), the boundary at exactly the capacity, a note linked to the invoice and
 * a supplier note not gated, a legacy invoice (no state) not limited, and the amount an unnamed apply takes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ state: null as { remainingNet: number; remainingVat: number } | null, calls: [] as unknown[][] }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ invoice_number: 'INV-7' }]) }));
vi.mock('@/modules/accounting/services/ar/invoiceRevenuePosting', () => ({
  typedInvoiceCreditState: vi.fn(async (...args: unknown[]) => { h.calls.push(args); return h.state; }),
}));

import {
  typedApplicationAmount, typedApplicationLimit, typedApplicationRefusal, typedAmountOrRefuse,
} from '@/modules/accounting/services/ar/creditNoteTypedApplication';

const CO = '11111111-1111-4111-8111-111111111111';
const Y = '22222222-2222-4222-8222-222222222222';
const note = (over: Record<string, unknown> = {}) => ({ id: 'n1', number: 'CN-1', type: 'customer', customerInvoiceId: null, ...over });

beforeEach(() => { h.state = { remainingNet: 50, remainingVat: 7.5 }; h.calls = []; });

describe('typedApplicationRefusal', () => {
  it('reads the CURRENT state (the note is not left out: its existing row counts)', async () => {
    await typedApplicationRefusal(CO, note(), Y, 1);
    expect(h.calls).toEqual([[CO, Y]]);
  });
  it('exactly the capacity is allowed; a cent more is refused with the true message', async () => {
    expect(await typedApplicationRefusal(CO, note(), Y, 57.5)).toBeNull();
    expect(await typedApplicationRefusal(CO, note(), Y, 57.51)).toBe('Credit note CN-1 cannot apply 57.51 more to invoice INV-7: '
      + 'it has 57.50 left to credit (50.00 net and 7.50 VAT); other credit notes already credited the rest without being applied to it. '
      + 'Apply 57.50 at most, apply this note to another invoice, or leave it on account.');
  });
  it('nothing left: the message says so (no "at most")', async () => {
    h.state = { remainingNet: 0, remainingVat: 0 };
    expect(await typedApplicationRefusal(CO, note(), Y, 0.01)).toBe('Credit note CN-1 cannot apply 0.01 more to invoice INV-7: it has '
      + 'nothing left to credit; other credit notes already credited it without being applied to it. Apply this note to another invoice, or leave it on account.');
  });
  it('negative VAT left (hand-made) counts as none', async () => {
    h.state = { remainingNet: 10, remainingVat: -5 };
    expect(await typedApplicationLimit(CO, note(), Y)).toEqual({ cap: 1000, net: 1000, vat: 0 });
  });
  it('a note linked to the invoice (any case) and a supplier note are not gated, and read nothing', async () => {
    expect(await typedApplicationRefusal(CO, note({ customerInvoiceId: Y.toUpperCase() }), Y, 1000)).toBeNull();
    expect(await typedApplicationRefusal(CO, note({ type: 'supplier' }), Y, 1000)).toBeNull();
    expect(h.calls).toEqual([]);
  });
  it('a legacy invoice (no typed state) has no limit', async () => {
    h.state = null;
    expect(await typedApplicationRefusal(CO, note(), Y, 1e6)).toBeNull();
    expect(await typedApplicationLimit(CO, note(), Y)).toBeNull();
  });
});

describe('typedApplicationAmount / typedAmountOrRefuse (round 5 L1)', () => {
  it('no amount named: capped at the capacity', async () => {
    expect(await typedApplicationAmount(CO, note(), Y, 115, false)).toEqual({ amount: 57.5 });
    expect(await typedApplicationAmount(CO, note(), Y, 20, false)).toEqual({ amount: 20 });
  });
  it('a named amount past it, or nothing left: refused', async () => {
    expect(await typedApplicationAmount(CO, note(), Y, 115, true)).toMatchObject({ refusal: expect.stringContaining('Apply 57.50 at most') });
    h.state = { remainingNet: 0, remainingVat: 0 };
    expect(await typedApplicationAmount(CO, note(), Y, 5, false)).toMatchObject({ refusal: expect.stringContaining('nothing left to credit') });
  });
  it('typedAmountOrRefuse: a supplier document passes untouched; a refusal is thrown as the caller builds it', async () => {
    expect(await typedAmountOrRefuse(CO, 'supplier', { id: 'n1', type: 'supplier' }, Y, 999, true, (m) => new Error(m))).toBe(999);
    class Refusal extends Error {}
    await expect(typedAmountOrRefuse(CO, 'customer', { id: 'n1', type: 'customer', credit_note_number: 'CN-1' }, Y, 115, true,
      (m) => new Refusal(m))).rejects.toBeInstanceOf(Refusal);
  });
});
