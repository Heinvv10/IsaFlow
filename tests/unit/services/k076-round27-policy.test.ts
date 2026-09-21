/**
 * Round 27 (review of `a2c0cf028`, 2H/1L).
 *
 * HIGH-1 (a round-26 regression): the round-26 tax spellings (`Plus VAT`,
 * `Add: VAT`, `15% VAT`, `Value Added Tax`) were summary lines everywhere, so
 * printed BELOW the total they explained themselves as the tax, and `Total
 * R1 000.00 / Plus VAT 150.00` posted R1 000 against R1 150. HIGH-2: the tax
 * counted once only inside the block; `TOTAL 1150.00 / Total Freight 150.00`
 * posted. LOW: `Copy 2/2`, `Copy (2 of 2)`, `Print 2 of 2`, `Copies: 2 of 2`.
 * Every input is the round-26 reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { unattendedPostingRefusal, refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const LABOUR = `${HDR('Joe Plumbing CC')}Labour 1000.00\n`;
const passes = (text: string, subtotal: number | null, vat: number, total: number) => {
  const doc = { documentType: 'invoice' as const, rawText: text, subtotal, vatAmount: vat, totalAmount: total,
    warnings: [], extractionMethod: 'vlm' as const };
  return unattendedPostingRefusal(doc) === null || !refusesUnattendedApproval(doc);
};

describe('K-076 r27 HIGH-1 — a tax line printed BELOW the total means the total read is pre-tax', () => {
  const RENO = (vl: string) => `Smith Renovations\nINVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 0045\n`
    + `Painting of lounge 1000.00\nTotal R1 000.00\n${vl}\nBanking details: FNB Acc 62812345678`;
  it.each(['Plus VAT 150.00', 'Plus VAT R150.00', 'Plus 15% VAT 150.00', 'Plus: VAT 150.00', 'Add VAT 150.00',
    'Add: VAT @ 15% 150.00', 'PLUS VAT 15% 150.00', 'Add 15% VAT R 150.00', '15% VAT 150.00', 'Value Added Tax 150.00'])(
    '"%s" after a R1 000 total refuses on both routes, whichever total the model chose', (vl) => {
      for (const text of [`${LABOUR}Total 1000.00\n${vl}`, RENO(vl)]) {
        for (const sub of [850, null]) expect(passes(text, sub, 150, 1000)).toBe(false);
        expect(passes(text, 1000, 150, 1150)).toBe(false);
      }
    });

  it('the pre-tax total printed AGAIN after the Plus line: only the Plus/Add adjustment sees it', () => {
    // Rule 3 reads below the LAST print of the total, so the `Plus VAT` line
    // between two prints of R1 000 is below nothing it checks.
    for (const again of ['Amount Due 1000.00', 'Total 1000.00']) {
      expect(passes(`${LABOUR}Total 1000.00\nPlus VAT 150.00\n${again}`, 850, 150, 1000)).toBe(false);
      expect(passes(`${LABOUR}Total 1000.00\nAdd: VAT 150.00\n${again}`, null, 150, 1000)).toBe(false);
    }
  });

  it('the inclusive layouts still post: VAT recapped after the total, and `Plus VAT` inside the block', () => {
    const slip = `${HDR('SPAR')}Bread 115.00\nTOTAL 115.00\nCARD 115.00\nVAT @ 15% 15.00`;
    expect(unreconciledFigure(slip, 115, { subtotal: 100, vatAmount: 15 })).toBeNull();
    expect(unreconciledFigure(`${LABOUR}Sub Total 1000.00\nPlus VAT 150.00\nTOTAL 1150.00`, 1150, { subtotal: 1000, vatAmount: 150 })).toBeNull();
  });
});

describe('K-076 r27 HIGH-2 — below the total, only a line that IS the tax may carry its value', () => {
  const LABELS = ['Total Delivery', 'Total Freight', 'Total Callout', 'Total Service', 'Total Travel', 'Total Transport',
    'Total Levy', 'Sub Total Delivery', 'Nett Delivery', 'Total Excl VAT Delivery', 'Amount Due Delivery',
    'VAT on delivery', 'Tax on levy'];
  const BLOCKS = ['Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00', 'VAT 15% 150.00\nTOTAL 1150.00', 'TOTAL 1150.00\nVAT INCL 150.00'];
  it.each(LABELS.flatMap((l) => BLOCKS.map((b) => [l, b])))('"%s 150.00" under %j refuses, stored and nulled', (label, block) => {
    const text = `${LABOUR}${block}\n${label} 150.00`;
    for (const sub of [1000, null]) {
      expect(unreconciledFigure(text, 1150, { subtotal: sub, vatAmount: 150 })).not.toBeNull();
      expect(passes(text, sub, 150, 1150)).toBe(false);
    }
  });

  it.each([
    'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\nTotal VAT 150.00',
    'Total Excl VAT 1000.00\nVAT 150.00\nTotal Incl VAT 1150.00\nVAT Summary 15% 1000.00 150.00',
    'Total Exclusive 1000.00\nTotal VAT 150.00\nTotal 1150.00',
  ])('an honest block that prints the tax again below the total posts: %j', (block) => {
    expect(unreconciledFigure(`${LABOUR}${block}`, 1150, { subtotal: 1000, vatAmount: 150 })).toBeNull();
  });
});

describe('K-076 r27 LOW — the siblings of `Copy N of M`', () => {
  const makro = (footer: string) => `Makro Woodmead\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 004512\n`
    + `Date: 2026-09-05\nCOFFEE 1KG 189.99\nSub Total 165.21\nVAT 24.78\nTOTAL 189.99\nCARD 189.99\n${footer}`;
  const purchase = (text: string) => identifiesAsPurchase({ rawText: text, documentType: 'invoice' });

  it.each(['Copy 2/2', 'Copy (2 of 2)', 'Print 2 of 2', 'Copies: 2 of 2'])('"%s" refuses', (footer) => {
    expect(purchase(makro(footer))).toBe(false);
  });

  it.each(['Page 2 of 2', 'Page 1 of 2', 'Pg 2/2'])('"%s" is a page, not a copy', (footer) => {
    expect(purchase(makro(footer))).toBe(true);
  });

  it('the copy shop still posts R115', () => {
    const shop = 'Minuteman Press\nTAX INVOICE\nVAT No 4123456789\nA4 COPY 50 90.00\nColour copy 10 x 2.50 25.00\n'
      + 'Sub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00';
    expect(passes(shop, 100, 15, 115)).toBe(true);
  });
});
