/**
 * Round 26 (review of `5923eaf3c`, 1H/1M/3L).
 *
 * HIGH: a summary-labelled charge EQUAL TO THE TAX (`Total Delivery 150.00`
 * beside `VAT 15% 150.00`) passed the block twice over — as the tax, and as
 * the pair `150 + Sub Total 1000 = 1150`. The tax is one figure, explained
 * once. MEDIUM: `Copy 2 of 2` after other text on its line (a regression of
 * round 25). LOWs (the paid-twin warning pin is in k076-ocr-subtotal-reconciliation):
 * the pair rule's `j !== i`; six honest VAT spellings. The reviewer's inputs.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { unattendedPostingRefusal, refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const LABOUR = `${HDR('Joe Plumbing CC')}Labour 1000.00\n`;
const PK = { subtotal: 1000, vatAmount: 150 };
const NO_NET = { subtotal: null, vatAmount: 150 };
const gate = (text: string, subtotal: number | null, vat: number, total: number) => {
  const doc = { documentType: 'invoice' as const, rawText: text, subtotal, vatAmount: vat, totalAmount: total,
    warnings: [], extractionMethod: 'vlm' as const };
  return { post: unattendedPostingRefusal(doc) === null, approve: !refusesUnattendedApproval(doc) };
};

const LABELS = ['Total Delivery', 'Total Freight', 'Total Callout', 'Total Service', 'Total Travel', 'Total Transport',
  'Total Levy', 'Sub Total Delivery', 'Nett Delivery', 'Total Excl VAT Delivery', 'Amount Due Delivery',
  'VAT on delivery', 'Tax on levy'];
const LAYOUTS = (label: string) => [
  `Sub Total 1000.00\n${label} 150.00\nVAT 15% 150.00\nTOTAL 1150.00`,
  `Sub Total 1000.00\nVAT 15% 150.00\n${label} 150.00\nTOTAL 1150.00`,
  `${label} 150.00\nVAT 15% 150.00\nTOTAL 1150.00`,
];

describe('K-076 r26 HIGH — a second figure equal to the tax is a charge', () => {
  it.each(LABELS.flatMap((l) => LAYOUTS(l).map((block) => [l, block])))(
    '"%s" equal to the VAT refuses on both routes, stored and with subtotal null: %j', (_l, block) => {
      const text = `${LABOUR}${block}`;
      expect(unreconciledFigure(text, 1150, PK)).not.toBeNull();
      expect(unreconciledFigure(text, 1150, NO_NET)).not.toBeNull();
      for (const sub of [1000, null]) expect(gate(text, sub, 150, 1150)).toEqual({ post: false, approve: false });
    });

  it.each(['Total Delivery', 'Total Freight', 'Total Callout'])('"%s 300.00" on 2000 + 300 refuses', (label) => {
    const text = `${HDR('Joe Plumbing CC')}Labour 2000.00\nSub Total 2000.00\n${label} 300.00\nVAT 15% 300.00\nTOTAL 2300.00`;
    expect(unreconciledFigure(text, 2300, { subtotal: 2000, vatAmount: 300 })).not.toBeNull();
    expect(unreconciledFigure(text, 2300, { subtotal: null, vatAmount: 300 })).not.toBeNull();
  });

  it('the tax printed once still posts; printed twice is the stated fail-closed cost', () => {
    for (const block of ['VAT 15% 150.00\nTOTAL 1150.00', 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00']) {
      expect(unreconciledFigure(`${LABOUR}${block}`, 1150, PK)).toBeNull();
      expect(unreconciledFigure(`${LABOUR}${block}`, 1150, NO_NET)).toBeNull();
    }
    expect(unreconciledFigure(`${LABOUR}Sub Total 1000.00\nVAT 15% 150.00\nTotal VAT 150.00\nTOTAL 1150.00`, 1150, PK)).not.toBeNull();
  });

  it('LOW: a figure does not pair with itself (`Total Delivery 575.00` is half the total)', () => {
    const text = `${LABOUR}Sub Total 1000.00\nTotal Delivery 575.00\nVAT 15% 150.00\nTOTAL 1150.00`;
    expect(unreconciledFigure(text, 1150, PK)).toEqual({ reason: 'stray', value: 575 });
  });
});

describe('K-076 r26 MEDIUM — `Copy N of M` anywhere on its line', () => {
  const makro = (footer: string) => `Makro Woodmead\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 004512\n`
    + `Date: 2026-09-05\nCOFFEE 1KG 189.99\nSub Total 165.21\nVAT 24.78\nTOTAL 189.99\nCARD 189.99\n${footer}`;
  const purchase = (text: string) => identifiesAsPurchase({ rawText: text, documentType: 'invoice' });

  it.each(['TAX INVOICE COPY 2 OF 2', 'Invoice copy 2 of 2', 'Page 1 of 1  Copy 2 of 2', 'COPY #2'])('"%s" refuses', (footer) => {
    expect(purchase(makro(footer))).toBe(false);
  });

  it.each(['A4 COPY 50 90.00\nColour copy 10 x 2.50 25.00', 'A4 Copy 80gsm 1 90.00 90.00\nColour copy 10 x 2.50 25.00'])(
    'the copy shop still posts: %j', (body) => {
      const shop = `Minuteman Press\nTAX INVOICE\nVAT No 4123456789\n${body}\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`;
      expect(purchase(shop)).toBe(true);
      expect(gate(shop, 100, 15, 115).post).toBe(true);
    });
});

describe('K-076 r26 LOW — six honest VAT spellings are tax lines, and the list fails closed', () => {
  it.each(['Plus VAT', 'Add: VAT', '15% VAT', 'Add 15% VAT', 'Tax 15%', 'Value Added Tax'])(
    '"%s 150.00" on an unpaid invoice posts; beside a charge, or holding one, it refuses', (label) => {
      expect(gate(`${LABOUR}${label} 150.00\nTOTAL 1150.00`, 1000, 150, 1150)).toEqual({ post: true, approve: true });
      // The figure on a tax line is explained by value only: 350 is not the tax.
      expect(unreconciledFigure(`${LABOUR}${label} 350.00\nTOTAL 1150.00`, 1150, PK)).not.toBeNull();
      // The same prefix before a NON-tax word is an item row, and a charge.
      const charge = label.replace(/Value Added Tax|VAT|Tax/i, 'Delivery');
      expect(unreconciledFigure(`${LABOUR}${charge} 150.00\n${label} 150.00\nTOTAL 1150.00`, 1150, PK)).not.toBeNull();
    });
});
