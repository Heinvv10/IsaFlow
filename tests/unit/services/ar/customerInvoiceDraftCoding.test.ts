/**
 * Review round 1 item 9: a draft edit that leaves a coding key out of a line
 * KEEPS the stored value when that is unambiguous, refuses when the stored
 * lines differ (there is no stable line identity to match on), clears on null;
 * an empty string never gets this far (PutItemSchema refuses it, as before).
 */
import { describe, expect, it } from 'vitest';
import { resolveEditCodings } from '@/modules/accounting/services/ar/customerInvoiceDraftCoding';
import { PutItemSchema } from '@/lib/schemas/customerInvoiceDetail';

const A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const stored = (glAccountId: string | null, projectId: string | null = null) => ({ glAccountId, projectId });

describe('resolveEditCodings', () => {
  it('an absent key keeps the value every stored line carries', () => {
    expect(resolveEditCodings([{}, {}], [stored(A, B), stored(A, B)]))
      .toEqual([stored(A, B), stored(A, B)]);
  });

  it('an invoice with no stored lines keeps nothing', () => {
    expect(resolveEditCodings([{}], [])).toEqual([stored(null)]);
  });

  it('refuses an absent key the stored lines disagree on, naming it, and keeps the keys they agree on', () => {
    expect(resolveEditCodings([{ glAccountId: A }], [stored(A, B), stored(null, B)])).toEqual([stored(A, B)]);
    expect(resolveEditCodings([{ projectId: null }], [stored(A, B), stored(null, B)]))
      .toBe('items[0].glAccountId was left out, and this invoice\'s lines carry different values for it — send it for every line (null clears it).');
  });

  it('null clears, a uuid sets (lower-cased)', () => {
    expect(resolveEditCodings([{ glAccountId: null, projectId: B.toUpperCase() }], [stored(A, null)]))
      .toEqual([stored(null, B)]);
  });

  it('an empty string is refused by the schema before it reaches the resolver', () => {
    expect(PutItemSchema.safeParse({ description: 'x', quantity: 1, unitPrice: 1, glAccountId: '' }).success).toBe(false);
  });
});
