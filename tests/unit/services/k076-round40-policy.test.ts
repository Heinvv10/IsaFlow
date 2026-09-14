/**
 * Round 40 (review of `1037fb98c`, 0H/0M/2L).
 *
 * LOW-1: a mixed-case `Wat` label still passed when a separator other than
 * `: = @ -` stood before its figure (`Wat ........ 260.86`, `Wat | 260.86`,
 * `Wat — 260.86`) or when a column layout printed the word alone on its line.
 * Now ANY run of separators counts, and the word alone on a line is a label.
 * Prose `wat` still passes. DB side: `k072-vat-declaration`.
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';

const ev = (rawText: string, totalAmount = 2420) => evidencedVat({ vatAmount: null, rawText, totalAmount, subtotal: null });
const page = (taxLines: string) => `Bosman Foods\nWe are not VAT registered.\nCooldrinks 1739.14\nBrown bread 420.00\n${taxLines}\nTOTAL 2420.00`;

describe('K-076 r40 LOW-1 — `Wat` behind any run of separators, or alone on its line', () => {
  it.each(['Wat ........ 260.86', 'Wat | 260.86', 'Wat — 260.86', 'Wat – 260.86', 'Wat * 260.86', 'Wat, 260.86', 'Wat; 260.86',
    'Wat_260.86', 'Wat/260.86', 'Wat ZAR 260.86', 'Wat (R) 260.86', 'Wat:', 'Wat', 'wAT .... 260.86'])(
    '`%s` is a tax label: the declaration beside it is refused', (line) => {
      expect(ev(page(line))).toBeNull();
    });

  it('the reviewer\'s column layout: labels in one column, figures below — `Wat` alone on its line', () => {
    expect(ev('Bosman Foods\nWe are not VAT registered.\nCooldrinks\nBrown bread\nSubtotal\nWat\nTOTAL\n1806.14\n420.00\n2226.14\n260.86\n2487.00', 2487))
      .toBeNull();
  });

  it.each(['Werk wat gedoen is 260.86', 'Items wat afgelewer is 260.86', 'Water 260.86', 'Watt meter 260.86'])(
    'the other direction: `%s` is no tax label', (line) => {
      expect(ev(page(line))).toBe(0);
    });

  it('fails closed where prose puts a figure straight after `wat`: `Alles wat - 260.86 kos` refuses (a person looks)', () => {
    expect(ev(page('Alles wat - 260.86 kos'))).toBeNull();
  });
});
