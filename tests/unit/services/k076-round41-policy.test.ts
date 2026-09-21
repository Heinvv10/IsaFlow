/**
 * Round 41 (review of `c0d537427`, 0H/0M/1L).
 *
 * LOW: a `Wat` column header between other words (`Item Qty Price Wat Total`,
 * `Subtotal Wat TOTAL`) still passed. Inverted after four rounds of shapes:
 * `wat` in any spelling is a tax mention EXCEPT on an Afrikaans PROSE line —
 * exactly lower-case `wat`, followed by a lower-case word, at least three
 * words, no column-header word, no `%`. DB side: `k072-vat-declaration`.
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';

const ev = (line: string) => evidencedVat({ vatAmount: null, totalAmount: 2420, subtotal: null,
  rawText: `Bosman Foods\nWe are not VAT registered.\nCooldrinks 1739.14\nBrown bread 420.00\n${line}\nTOTAL 2420.00` });

describe('K-076 r41 — `wat` is a tax mention except on a prose line', () => {
  it.each(['Item Qty Price Wat Total', 'Subtotal Wat TOTAL', 'Item Qty Price wat Total', 'subtotal wat total'])(
    'the header `%s` is a tax mention: refused', (line) => {
      expect(ev(line)).toBeNull();
    });

  it.each(['Werk wat gedoen is 260.86', 'Items wat afgelewer is 260.86', 'Tuindiens wat in Mei gedoen is 260.86', 'Werk wat gedoen is'])(
    'Afrikaans prose `%s` still passes', (line) => {
      expect(ev(line)).toBe(0);
    });

  // One pin per prose condition, each failing closed.
  it.each([['capitalised in a prose shape', 'Werk Wat gedoen is 260.86'], ['a figure after it', 'Alles wat 260.86 kos'],
    ['too few words', 'wat is'], ['a %', 'Werk wat nou kos 5%'], ['a column word', 'Werk wat die bedrag is 260.86']])(
    'not prose (%s): `%s` refuses', (_why, line) => {
      expect(ev(line)).toBeNull();
    });
});
