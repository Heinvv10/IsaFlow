/**
 * A customer credit note linked to an invoice whose revenue legs carry a VAT type (migration 1008): each of the
 * note's revenue debits carries the type of the invoice leg it reverses, so a note against an exempt line reduces
 * VAT201 field 3, not field 2. Legs of the same account and tags but another type stay apart. An uncoded (legacy)
 * invoice leg gives an uncoded note leg, exactly as before, and the excess no leg can take posts uncoded.
 */
import { describe, it, expect } from 'vitest';
import { allocateCreditNote, type RevenueLeg } from '@/modules/accounting/services/ar/invoiceRevenueLines';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';

const DEFAULT = 'acct-default-revenue';
const leg = (net: number, vatType: RevenueLeg['vatType'], journalLineId: string): RevenueLeg =>
  ({ glAccountId: DEFAULT, projectId: null, cc1Id: null, cc2Id: null, buId: null, net, vatType, journalLineId });

describe('allocateCreditNote and typed invoice legs', () => {
  it('a full note debits each leg on its own type, the same account and tags kept apart by type', () => {
    const { lines } = allocateCreditNote([leg(1000, 'standard', 'l1'), leg(300, 'zero_rated', 'l2'), leg(200, 'exempt', 'l3')],
      1500, 'CN-1', DEFAULT);
    expect(lines.map((l) => [l.glAccountId, l.debit, l.credit, l.vatType])).toEqual([
      [DEFAULT, 1000, 0, 'standard'], [DEFAULT, 300, 0, 'zero_rated'], [DEFAULT, 200, 0, 'exempt'],
    ]);
    expect(validateJournalEntry([...lines, { glAccountId: 'acct-ar', debit: 0, credit: 1500 }]).valid).toBe(true);
  });

  it('a partial note against an exempt invoice debits exempt revenue', () => {
    const { lines } = allocateCreditNote([leg(1000, 'exempt', 'l1')], 400, 'CN-2', DEFAULT);
    expect(lines).toEqual([{ glAccountId: DEFAULT, debit: 400, credit: 0, description: 'Credit note CN-2', vatType: 'exempt' }]);
  });

  it('an uncoded (legacy) invoice leg gives the uncoded note leg it always did, merged with the excess', () => {
    const { lines } = allocateCreditNote([leg(1000, null, 'l1')], 1200, 'CN-3', DEFAULT);
    expect(lines).toEqual([{ glAccountId: DEFAULT, debit: 1200, credit: 0, description: 'Credit note CN-3' }]);
  });

  it('what no typed leg can take posts uncoded, apart from the typed leg on the same account', () => {
    const { lines } = allocateCreditNote([leg(1000, 'exempt', 'l1')], 1100, 'CN-4', DEFAULT);
    expect(lines.map((l) => [l.debit, l.vatType ?? null])).toEqual([[1000, 'exempt'], [100, null]]);
  });
});
