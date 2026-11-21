/**
 * The unapply / adjust-down guard on rule A (ar/creditNoteDetachedShift, #1701 rounds 6-7), on mocked reads: the keys
 * of every invoice the note is applied to are taken once each, in id order, from a company-scoped read; a rise past a
 * typed invoice's capacity is refused with the true message, a rise up to it is not; only the invoices whose count
 * rises are read (and their rows locked); a supplier note, a legacy invoice and the note's own linked invoice are not
 * judged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  allocations: [] as { invoice_id: string }[],
  keys: [] as string[],
  texts: [] as { text: string; values: unknown[] }[],
  profile: null as null | { detached: number; reversedOn: string[]; applications: { invoiceId: string; cents: number }[] },
  caps: {} as Record<string, number | null>,
  capReads: [] as string[],
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join('?');
    h.texts.push({ text, values });
    if (/FROM credit_note_allocations/.test(text)) return h.allocations;
    if (/invoice_number/.test(text)) return [{ invoice_number: 'INV-W' }];
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/ar/creditNotePostingChecks', () => ({
  lockInvoiceCreditNotes: vi.fn(async (id: string) => { h.keys.push(id); }),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteDetachedRead', () => ({
  detachedProfiles: vi.fn(async (_c: string, ids: string[]) => new Map(h.profile ? [[ids[0]!, h.profile]] : [])),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteTypedApplication', () => ({
  typedCreditCapacity: vi.fn(async (_c: string, id: string) => {
    h.capReads.push(id);
    const cap = h.caps[id];
    return cap == null ? null : { cap, net: cap, vat: 0 };
  }),
}));

import {
  detachedRisingInvoices, detachedShiftRefusal, lockNoteApplicationKeys,
} from '@/modules/accounting/services/ar/creditNoteDetachedShift';

const CO = '11111111-1111-4111-8111-111111111111';
const NOTE = { id: 'n1', credit_note_number: 'CN-9', type: 'customer', customer_invoice_id: 'x' };

beforeEach(() => {
  h.allocations = []; h.keys = []; h.texts = []; h.capReads = [];
  // D 57.50: X reversed (20), Y 57.50 takes all of D, W 95 counts nothing.
  h.profile = { detached: 5750, reversedOn: ['x'], applications: [{ invoiceId: 'x', cents: 2000 }, { invoiceId: 'y', cents: 5750 }, { invoiceId: 'w', cents: 9500 }] };
  h.caps = { y: 11500, w: 2300 };
});

describe('lockNoteApplicationKeys', () => {
  it('takes each key once, lower-case, in id order, from a company-scoped read of the note\'s applications', async () => {
    h.allocations = [{ invoice_id: 'CCC' }, { invoice_id: 'aaa' }, { invoice_id: 'ccc' }];
    await lockNoteApplicationKeys(CO, 'n1', ['BBB', 'aaa']);
    expect(h.keys).toEqual(['aaa', 'bbb', 'ccc']);
    const read = h.texts.find((t) => /FROM credit_note_allocations/.test(t.text))!;
    expect(read.text).toMatch(/company_id = \?::UUID AND credit_note_id = \?::UUID/);
    expect(read.values).toEqual([CO, 'n1']);
  });
});

describe('detachedShiftRefusal', () => {
  it('unapplying Y would move 57.50 onto W with 23.00 left: refused, naming both figures', async () => {
    expect(await detachedShiftRefusal(CO, NOTE, new Map([['y', 0]]))).toBe(
      'Credit note CN-9 cannot be taken back this far: it would move 57.50 of its credit onto invoice INV-W, which has '
      + '23.00 left to credit (other credit notes credited it since). Take back less, or take this note\'s application to '
      + 'that invoice back first.');
    expect(h.capReads).toEqual(['w']);
    const inv = h.texts.find((t) => /invoice_number/.test(t.text))!;
    expect(inv.text).toMatch(/company_id = \?::UUID/);
    expect(inv.values).toEqual(['w', CO]);
  });
  it('a rise up to the capacity is allowed (Y down to 34.50: W rises 23.00), a cent more is not', async () => {
    expect(await detachedShiftRefusal(CO, NOTE, new Map([['y', 34.5]]))).toBeNull();
    expect(await detachedShiftRefusal(CO, NOTE, new Map([['y', 34.49]]))).toMatch(/would move 23\.01 of its credit onto invoice INV-W, which has 23\.00 left/);
  });
  it('a legacy invoice (no capacity), a supplier note, a change that only lowers counts and an unknown note are not refused', async () => {
    h.caps = { w: null };
    expect(await detachedShiftRefusal(CO, NOTE, new Map([['y', 0]]))).toBeNull();
    h.caps = { w: 0 };
    expect(await detachedShiftRefusal(CO, { ...NOTE, type: 'supplier' }, new Map([['y', 0]]))).toBeNull();
    expect(await detachedShiftRefusal(CO, NOTE, new Map([['x', 0], ['y', 0], ['w', 0]]))).toBeNull();
    expect(await detachedShiftRefusal(CO, NOTE, new Map([['x', 0]]))).toBeNull();
    h.profile = null;
    expect(await detachedShiftRefusal(CO, NOTE, new Map([['y', 0]]))).toBeNull();
  });
  it('the note\'s own linked invoice is not judged', async () => {
    h.caps = { w: 0 };
    expect(await detachedShiftRefusal(CO, { ...NOTE, customer_invoice_id: 'W' }, new Map([['y', 0]]))).toBeNull();
    expect(h.capReads).toEqual([]);
  });
});

describe('detachedRisingInvoices (the rows the live path locks before judging)', () => {
  it('only the invoices whose count would rise and that are judged', async () => {
    expect(await detachedRisingInvoices(CO, NOTE, new Map([['y', 0]]))).toEqual(['w']);
    expect(await detachedRisingInvoices(CO, NOTE, new Map([['x', 0]]))).toEqual([]);
    expect(await detachedRisingInvoices(CO, { ...NOTE, type: 'supplier' }, new Map([['y', 0]]))).toEqual([]);
  });
});
