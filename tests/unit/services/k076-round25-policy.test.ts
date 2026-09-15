/**
 * Round 25 (review of `45e49cb48`, 2H/3L, no regressions).
 *
 * HIGH-1: the item-column checks took the net from the stored subtotal, and a
 * VLM may store none — with `subtotal: null` the round-23 under-VAT rows
 * posted again. HIGH-2: a figure on a summary-labelled line inside the block
 * explained itself by its first word (`Total Freight 350.00`). The two cases
 * round 24 pinned open (a charge equal to the tax) close. LOW-1: more reprint
 * markings, and `Copy 2` no longer refuses photocopies. LOW-2: two anchors
 * pinned. Every input is the round-24 reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const LABOUR = `${HDR('Joe Plumbing CC')}Labour 1000.00\n`;
const PBLOCK = 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n';
const NO_NET = { subtotal: null, vatAmount: 150 };
const PK = { subtotal: 1000, vatAmount: 150 };

describe('K-076 r25 HIGH-1 — with no stored subtotal the net is total − VAT', () => {
  it.each(['Delivery 100.00', 'Call-out 149.00', 'Delivery 50.00', 'Callout R120', 'Parts 1 99.00 99.00',
    'Delivery R 100.00', 'Hire 1 day 120', 'Delivery 350.00', 'Hire 1 day 450'])(
    '"%s" beside the labour refuses with subtotal null', (row) => {
      expect(unreconciledFigure(`${LABOUR}${row}\n${PBLOCK}`, 1150, NO_NET)).not.toBeNull();
    });

  it.each(['Sub Total 1000.00\nDelivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nVAT 15% 150.00\nCall-out 100.00\nTOTAL 1150.00'])('a summary-block charge refuses with subtotal null: %j', (block) => {
    expect(unreconciledFigure(`${LABOUR}${block}`, 1150, NO_NET)).not.toBeNull();
  });

  it('an invoice printing no sub total line: the charge refuses, the honest twin posts', () => {
    expect(unreconciledFigure(`${LABOUR}Delivery 100.00\nVAT 15% 150.00\nTOTAL 1150.00`, 1150, NO_NET)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}VAT 15% 150.00\nTOTAL 1150.00`, 1150, NO_NET)).toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}`, 1150, NO_NET)).toBeNull();
  });
});

describe('K-076 r25 HIGH-2 — a summary figure in the block is explained by value, not by its first word', () => {
  it.each([
    'Sub Total 1000.00\nTotal Delivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nTotal Freight 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nTotal Callout 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nVAT 15% 150.00\nTotal Delivery 350.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nVAT on delivery 52.50\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nTax on levy 52.50\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nTotal Discount 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nVAT 15% 150.00 Delivery 350.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nTotal Excl VAT Delivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nSub Total Delivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nAmount Due Delivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nNett Delivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00 Delivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
  ])('%j refuses, with and without a stored net', (block) => {
    expect(unreconciledFigure(`${LABOUR}${block}`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}${block}`, 1150, NO_NET)).not.toBeNull();
  });

  it.each([PBLOCK, 'Total Excl 1000.00\nVAT 15% 150.00\nTotal Incl 1150.00'])('the honest block %j posts', (block) => {
    expect(unreconciledFigure(`${LABOUR}${block}`, 1150, PK)).toBeNull();
    expect(unreconciledFigure(`${LABOUR}${block}`, 1150, NO_NET)).toBeNull();
    expect(unreconciledFigure(`${LABOUR}${block}`, 1150)).toBeNull();
  });
});

describe('K-076 r25 — a row equal to the tax, where the rows sum to the total, on an unpaid invoice', () => {
  it.each(['Delivery 150.00', 'Travel 149.99', 'Travel 150.01'])('"%s" beside the labour refuses', (row) => {
    expect(unreconciledFigure(`${LABOUR}${row}\n${PBLOCK}`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}${row}\n${PBLOCK}`, 1150, NO_NET)).not.toBeNull();
  });

  it('a paid VAT-inclusive slip whose sauce happens to equal the VAT still posts (no label can tell them apart)', () => {
    const burger = `${HDR('Spur')}Burger 100.00\nSauce 15.00\nTotal Excl 100.00\nVAT 15.00\nTOTAL 115.00\nCARD 115.00`;
    expect(unreconciledFigure(burger, 115, { subtotal: 100, vatAmount: 15 })).toBeNull();
  });
});

describe('K-076 r25 LOW-1 — reprint markings, and photocopies are a purchase', () => {
  const makro = (footer: string) => `Makro Woodmead\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 004512\n`
    + `Date: 2026-09-05\nCOFFEE 1KG 189.99\nSub Total 165.21\nVAT 24.78\nTOTAL 189.99\nCARD 189.99\n${footer}`;
  const purchase = (text: string) => identifiesAsPurchase({ rawText: text, documentType: 'invoice' });

  it.each(['COPY ONLY', 'COPY RCPT', 'COPY INV', 'RE-PRT', 'REPRT', 'REPR.', 'Rpt', 'R E P R I N T', 'D U P L I C A T E',
    'NOT AN ORIGINAL', 'Second print', 'Printed again', 'Copy 2 of 2', 'Copy No 2'])('"%s" refuses', (footer) => {
    expect(purchase(makro(footer))).toBe(false);
  });

  it('a copy shop\'s photocopies are an item, not a marker', () => {
    const shop = `Minuteman Press\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 004512\nColour copy 10 x 2.50 25.00\n`
      + 'A4 COPY 50\nBinding 75.00\nSub Total 100.00\nVAT 15.00\nTOTAL 115.00';
    expect(purchase(shop)).toBe(true);
  });
});

describe('K-076 r25 LOW-2 — the anchors no test pinned', () => {
  it.each(['Previous balance 350.00 interest', 'Previous balance 350.00 + 2% 7.00', 'Opening balance 350.00 due now',
    'Balance forward 350.00 plus interest 35.00'])('"%s" is not a bare prior balance (the END anchor)', (row) => {
    expect(unreconciledFigure(`${LABOUR}${row}\n${PBLOCK}`, 1150, PK)).not.toBeNull();
  });

  it('a WHOLE number inside the summary block is a figure too', () => {
    expect(unreconciledFigure(`${LABOUR}Sub Total 1000.00\nDelivery 350\nVAT 15% 150.00\nTOTAL 1150.00`, 1150, PK)).not.toBeNull();
  });

  it('a change label must END as one: `Change brake pads` beside a cash tender and its change is a charge', () => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}CASH 1850.00\nCHANGE 350.00\nChange brake pads 350.00`, 1150, PK)).not.toBeNull();
  });
});
