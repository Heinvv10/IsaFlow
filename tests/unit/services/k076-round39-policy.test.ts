/**
 * Round 39 (review of `90653fa41`, 0H/0M/1L).
 *
 * LOW-1: round 38's capitals-only `WAT` let mixed-case `Wat 130.43` / `wAT`
 * through. `wat` now counts in ANY case where the line is shaped like a tax
 * label (the word, a separator, then an amount / `%` / `R` / "amount"); the
 * Afrikaans prose word still passes. DB side: `k072-vat-declaration`.
 * Disclosed residual (open at base too): a customer-first page, or a remittance
 * tear-off below the total, still counts a customer's declaration.
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';

const ev = (rawText: string, totalAmount = 1210) => evidencedVat({ vatAmount: null, rawText, totalAmount, subtotal: null });
const page = (taxLine: string) => `Bosman Foods\nWe are not VAT registered.\nCooldrinks 869.57\nBrown bread 210.00\n${taxLine}\nTOTAL 1210.00`;

describe('K-076 r39 LOW-1 — label-shaped `wat`, any case', () => {
  it.each(['Wat 130.43', 'wAT 130.43', 'wat: 130.43', 'Wat R130.43', 'Wat @ 15%', 'Wat amount 130.43', 'UAT 130.43', 'W.A.T 130.43', 'Wat-130.43'])(
    '`%s` is a tax label: the declaration beside it is refused', (line) => {
      expect(ev(page(line))).toBeNull();
    });

  it.each(['Werk wat gedoen is 130.43', 'Items wat afgelewer is 130.43', 'Water 130.43', 'Watt meter 130.43', 'Whatever 130.43'])(
    'the other direction: `%s` is no tax label', (line) => {
      expect(ev(page(line))).toBe(0);
    });
});

describe('K-076 r39 — DISCLOSED RESIDUAL, open at base too, pinned so a change to it is seen', () => {
  it('a remittance tear-off below the total counts the customer\'s declaration as the supplier\'s', () => {
    expect(ev('Bosman Foods\nINVOICE\nCooldrinks 1210.00\nTOTAL 1210.00\n- - - cut here - - -\nREMITTANCE ADVICE\nMokoena Trading\nNot VAT registered')).toBe(0);
  });
  it('a customer-first page counts the customer\'s declaration as the supplier\'s', () => {
    expect(ev('Mokoena Trading\nNot VAT registered\nBosman Foods\nINVOICE\nCooldrinks 1210.00\nTOTAL 1210.00')).toBe(0);
  });
});
