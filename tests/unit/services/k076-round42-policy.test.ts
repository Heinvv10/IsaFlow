/**
 * Round 42 (review of `9e71995fa`, 0H/0M/1L).
 *
 * LOW: the currency `R` counted toward the prose exemption's three-word
 * minimum, so `wat ingesluit R260.86`, `wat payable R260.86` and `wat charged
 * R 260.86` passed as prose. Now (1) a currency (`R`, `ZAR`) is never a word,
 * and (2) prose needs a word right BEFORE `wat` — the Afrikaans pronoun
 * follows its antecedent. DB side: `k072-vat-declaration`.
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';

const ev = (line: string) => evidencedVat({ vatAmount: null, totalAmount: 2420, subtotal: null,
  rawText: `Bosman Foods\nWe are not VAT registered.\nCooldrinks 1739.14\nBrown bread 420.00\n${line}\nTOTAL 2420.00` });

describe('K-076 r42 — a currency is no word, and prose has a word before `wat`', () => {
  it.each(['wat ingesluit R260.86', 'wat payable R260.86', 'wat charged R 260.86', 'wat payable ZAR 260.86'])(
    'the reviewer\'s shape `%s` refuses', (line) => {
      expect(ev(line)).toBeNull();
    });

  it.each(['Werk wat gedoen is 260.86', 'Items wat afgelewer is 260.86', 'Tuindiens wat in Mei gedoen is 260.86', 'Alles wat gedoen is R260.86'])(
    'prose `%s` still passes', (line) => {
      expect(ev(line)).toBe(0);
    });

  // Each condition decides one pin alone.
  it('(2) a line that OPENS with `wat` is a label, even with three real words: `wat ingesluit is R260.86` refuses', () => {
    expect(ev('wat ingesluit is R260.86')).toBeNull();
  });
  it('(1) a currency is not the antecedent: `R wat ingesluit is 260.86` refuses', () => {
    expect(ev('R wat ingesluit is 260.86')).toBeNull();
  });
});
