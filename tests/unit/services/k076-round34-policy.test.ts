/**
 * Round 34 (review of `684e251f6`, 1H/1M/0L).
 *
 * HIGH-1: "no VAT read" was evidence of none whenever the page printed no tax
 * WORD — a vocabulary guarding the dangerous direction, so `B.T.W. 375.00` on a
 * `FAKTUUR` approved with no VAT. Inverted: none read evidences 0 ONLY when the
 * document SAYS no VAT applies and prints no VAT number (DB side in
 * `k072-capture-vat-unread`, `k072-journal-vat-evidence`). The reader also
 * learns `B.T.W.`, `B T W`, `V A T` and `persent` — a help to reading, no longer
 * what makes approval safe. MEDIUM-1 (the vendor-name fold) is DB-only.
 */
import { describe, expect, it } from 'vitest';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';

const BOSMAN = (title: string, tail: string) => `Bosman Motors\n${title}\nInvoice No: 7781\nDate: 2026-04-10\nService 60 000km 2875.00\n`
  + `TOTAAL 2875.00\n${tail}\nBank: FNB 62000000000`;

describe('K-076 r34 HIGH-1 — none read evidences none only on a positive signal', () => {
  // The reviewer's shapes the round-33 word list read as "no tax printed", plus the ones the reader now reads.
  it.each(['B.T.W. 375.00', 'B.T.W. ingesluit 375.00', 'B T W 375.00', 'V A T 375.00', 'VAl 375.00', 'V4T 375.00',
    'Incl. 375.00', 'Incl 15 persent 375.00', ''])('a FAKTUUR printing `%s`, no VAT read: not evidenced', (tail) => {
    expect(evidencedVat({ vatAmount: null, rawText: BOSMAN('FAKTUUR', tail) })).toBeNull();
  });

  it('a page that prints no tax at all is no longer enough: nothing says none applies', () => {
    expect(evidencedVat({ vatAmount: null, rawText: 'K072 Garden\nGarden service 1000.00\nAmount Due 1000.00' })).toBeNull();
    for (const rawText of ['', '   ', undefined]) expect(evidencedVat({ vatAmount: null, rawText })).toBeNull();
    expect(evidencedVat(null)).toBeNull();
  });

  it.each(['Not VAT registered', 'NOT A VAT REGISTERED VENDOR', 'Supplier is not registered for VAT', 'Non-VAT registered',
    'Non VAT vendor', 'VAT not applicable', 'V.A.T. is not applicable', 'Nie BTW-geregistreer nie', 'nie vir B.T.W. geregistreer nie',
    'Nie geregistreer vir BTW nie', 'No VAT', 'NO VAT CHARGED', 'Geen BTW'])('the document declares `%s`: none is evidenced as 0', (line) => {
    expect(evidencedVat({ vatAmount: null, rawText: `Joe Garden Services\n${line}\nGarden service 1000.00\nAmount Due 1000.00` })).toBe(0);
  });

  it('a declaration on a page that also prints a VAT number, or `No VAT` inside a sentence, is no signal', () => {
    const joe = (extra: string) => `Joe Garden Services\n${extra}\nGarden service 1000.00\nAmount Due 1000.00`;
    expect(evidencedVat({ vatAmount: null, rawText: joe('Not VAT registered\nVAT No 4123450000') })).toBeNull();
    expect(evidencedVat({ vatAmount: null, rawText: joe('Not VAT registered\nBTW Nr 4123 450 000') })).toBeNull();
    expect(evidencedVat({ vatAmount: null, rawText: joe('No VAT on disbursements') })).toBeNull();
    expect(evidencedVat({ vatAmount: null, rawText: joe('This invoice is a VAT invoice; no VAT exemption applies') })).toBeNull();
  });

  it('a VAT read is still evidenced as read, zero included', () => {
    expect(evidencedVat({ vatAmount: 130.43, rawText: '' })).toBe(130.43);
    expect(evidencedVat({ vatAmount: 0, rawText: 'VAT 0.00' })).toBe(0);
  });
});

describe('K-076 r34 — the reader learns the dotted and spaced tax words and `persent`', () => {
  it.each(['B.T.W. 375.00', 'B.T.W.: 375.00', 'B T W 375.00', 'V A T 375.00', 'BTW @ 15 persent 375.00', 'VAT 15 persent 375.00'])(
    '`%s` is read as a VAT of 375', (line) => {
      expect(extractAmounts(BOSMAN('BELASTINGFAKTUUR', line)).vatAmount).toBe(375);
    });

  it('the other direction: a rate in `persent` is not read as the VAT, and `B.T.W. Nr` is not a figure', () => {
    expect(extractAmounts(BOSMAN('BELASTINGFAKTUUR', 'B.T.W. 15 persent\nB.T.W. 375.00')).vatAmount).toBe(375);
    expect(extractAmounts(BOSMAN('FAKTUUR\nB.T.W. Nr 4123450000', 'Kontant 2875.00')).vatAmount).toBeNull();
  });
});
