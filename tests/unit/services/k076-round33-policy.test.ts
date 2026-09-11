/**
 * Round 33 (review of `cbe8d5497`, 1H/0M/2L).
 *
 * HIGH-1: "no VAT read" is evidence of none only on a document whose text
 * prints no tax at all (`evidencedVat`; the DB side is in
 * `k072-capture-vat-unread` and `k072-journal-vat-evidence`). `Grand Total`
 * and `Invoice Total` were measured as payable labels and NOT admitted: they
 * reopen the fee-pair residual (fix.md round 33).
 * LOW-2: the four unpinned behaviours — the payable label on the total's OWN
 * line, the legend read per segment, and the two one-cent tolerances (DB side).
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { evidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';

describe('K-076 r33 HIGH-1 — the VAT a captured document evidences', () => {
  const NO_TAX = 'K072 Garden\nGarden service 1000.00\nAmount Due 1000.00';
  it('a VAT read is evidenced as read, zero included', () => {
    expect(evidencedVat({ vatAmount: 130.43, rawText: '' })).toBe(130.43);
    expect(evidencedVat({ vatAmount: 0, rawText: 'VAT 0.00' })).toBe(0);
  });
  it('none read is none only on a text printing no tax', () => {
    expect(evidencedVat({ vatAmount: null, rawText: NO_TAX })).toBe(0);
    expect(evidencedVat({ rawText: NO_TAX })).toBe(0);
  });
  it.each(['VAT INCL 375.00', 'Incl. VAT 375.00', 'V.A.T. 375.00', 'BTW ingesluit 375.00', 'BELASTINGFAKTUUR', 'TAX INVOICE',
    'VATNo:4123450000', 'Prices incl 15%', 'Tax 375.00'])('none read, but the page prints `%s`: not evidenced', (line) => {
    expect(evidencedVat({ vatAmount: null, rawText: `${NO_TAX}\n${line}` })).toBeNull();
  });
  it('no text proves nothing', () => {
    for (const rawText of ['', '   ', undefined]) expect(evidencedVat({ vatAmount: null, rawText })).toBeNull();
    expect(evidencedVat(null)).toBeNull();
  });
  it('the other direction: words that merely contain the letters are not a tax', () => {
    expect(evidencedVat({ vatAmount: null, rawText: `${NO_TAX}\nPrivate Bag X15\nElevator service 115.00` })).toBe(0);
  });
});

const HDR = 'Mokoena Attorneys\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 0045\nDate: 2026-09-01\n';
const BANK = 'Banking details: FNB Acc 62812345678';
const pretax = { reason: 'pretax' };

describe('K-076 r33 — `Grand Total` and `Invoice Total` are NOT payable labels (measured: they reopen the residual)', () => {
  const fee = (label: string, deeds: string, legend = '') =>
    `${HDR}Conveyancing fee 1000.00\n${deeds}\n${label} 1150.30\nVAT 15% 150.00\n${legend}${BANK}`;
  const PRE = { subtotal: 1000.3, vatAmount: 150 };
  it.each(['Grand Total', 'GRAND TOTAL', 'Invoice Total', 'INVOICE TOTAL'])('the unmarked pre-tax fee pair under `%s`, inside the window, refuses', (label) => {
    expect(unreconciledFigure(fee(label, 'Deeds office fee 150.30'), 1150.3, PRE)).toMatchObject(pretax);
  });
  it.each(['Grand Total', 'Invoice Total'])('THE COST, pinned: an honest unpaid `%s 1000.00 / VAT 130.43` goes to a person', (label) => {
    const text = `${HDR}Labour 1000.00\n${label} 1000.00\nVAT 130.43\n${BANK}`;
    expect(unreconciledFigure(text, 1000, { subtotal: 869.57, vatAmount: 130.43 })).toMatchObject(pretax);
  });
  it('`Items with a Z are zero-rated` defines Z: a marked fee pair under `Amount Due` refuses', () => {
    const text = fee('Amount Due', 'Deeds office fee Z 150.30', 'Items with a Z are zero-rated\n');
    expect(unreconciledFigure(text, 1150.3, PRE)).toMatchObject(pretax);
  });
});

describe('K-076 r33 LOW-2 — the unpinned behaviours', () => {
  it('the payable label counts only on the total\'s own line: `Amount due within 30 days` in a footer does not', () => {
    const text = `${HDR}Conveyancing fee 1000.00\nDeeds office fee 150.30\nTotal 1150.30\nVAT 15% 150.00\nAmount due within 30 days of invoice\n${BANK}`;
    expect(unreconciledFigure(text, 1150.3, { subtotal: 1000.3, vatAmount: 150 })).toMatchObject(pretax);
  });
  it('the legend is read per segment: `S = Standard 15%, Z = Zero rated` defines Z', () => {
    const text = `${HDR}Conveyancing fee 1000.00\nDeeds office fee Z 150.30\nAmount Due 1150.30\nVAT 15% 150.00\nS = Standard 15%, Z = Zero rated\n${BANK}`;
    expect(unreconciledFigure(text, 1150.3, { subtotal: 1000.3, vatAmount: 150 })).toMatchObject(pretax);
  });
});
