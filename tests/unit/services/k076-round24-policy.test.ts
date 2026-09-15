/**
 * Round 24 (review of `591193edb`, 3H/2M, no regressions).
 *
 * HIGH-1: a label merely CONTAINING "change" was exempt with no cash tender
 * (`Oil change 350.00`). HIGH-2: the prior-balance exclusion had no anchor
 * (`Interest on previous balance 350.00`). HIGH-3: on an unpaid invoice a
 * charge smaller than the VAT, or one printed inside the summary block, was
 * invisible. MEDIUM-1: `COPY RECEIPT`, `Copy 2 of 2`, `** DUP **`, `RPRNT`
 * footers. Every input is the round-23 reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { unattendedPostingRefusal, refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const LABOUR = `${HDR('Auto Fix Mechanics')}Labour 1000.00\n`;
const PBLOCK = 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n';
const PK = { subtotal: 1000, vatAmount: 150 };
const refusedBothRoutes = (text: string) => {
  const doc = { documentType: 'invoice' as const, rawText: text, subtotal: 1000, vatAmount: 150, totalAmount: 1150,
    warnings: [], extractionMethod: 'vlm' as const };
  return unattendedPostingRefusal(doc) !== null && refusesUnattendedApproval(doc);
};

describe('K-076 r24 HIGH-1 — a change is explained only as a cash tender\'s change', () => {
  const CHARGES = ['Oil change 350.00', 'Oil change service 350.00', 'Tyre change 350.00',
    'Wheel alignment & tyre change 350.00', 'Change oil and filter 350.00', 'Change brake pads 350.00', 'Wisselgeld 350.00'];

  it.each(CHARGES)('"%s" above the sub total, below the total, or below a card refuses', (row) => {
    expect(refusedBothRoutes(`${LABOUR}${row}\n${PBLOCK}`)).toBe(true);
    expect(refusedBothRoutes(`${LABOUR}${PBLOCK}${row}`)).toBe(true);
    expect(refusedBothRoutes(`${LABOUR}${PBLOCK}CARD 1150.00\n${row}`)).toBe(true);
  });

  it('the label must BE change: a cash payment cannot net an oil change as its "change"', () => {
    // CASH 1500 less a 350 "change" would balance to the total; the customer paid 1500.
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}CASH 1500.00\nOil change 350.00`, 1150, PK)).not.toBeNull();
    expect(refusedBothRoutes(`${LABOUR}${PBLOCK}CASH 1500.00\nTyre change 350.00`)).toBe(true);
  });

  it('a cash tender\'s change still nets; an oil change inside the sub total still posts', () => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}CASH 1200.00\nCHANGE 50.00`, 1150, PK)).toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}CASH 1200.00\nChange Due 50.00`, 1150, PK)).toBeNull();
    expect(unreconciledFigure(`${HDR('Auto Fix')}Labour 650.00\nOil change 350.00\n${PBLOCK}`, 1150, PK)).toBeNull();
  });
});

describe('K-076 r24 HIGH-2 — a prior balance is excluded only as a line of its own', () => {
  it.each(['Interest on previous balance 350.00', 'Late payment interest - previous balance 350.00',
    'Previous balance interest 350.00', 'Opening balance adjustment 350.00', 'Admin fee opening balance 350.00',
    'Balance forward fee 350.00', 'Callout (previous balance nil) 350.00'])('"%s" is a charge', (row) => {
    expect(refusedBothRoutes(`${LABOUR}${row}\n${PBLOCK}`)).toBe(true);
    expect(refusedBothRoutes(`${LABOUR}${PBLOCK}${row}`)).toBe(true);
  });

  it.each(['Balance brought forward 500.00', 'Balance b/f: R500.00', 'Previous balance 500.00',
    'Opening balance - 500.00', 'Vorige saldo 500.00'])('"%s" alone on its line is a prior document', (row) => {
    expect(unreconciledFigure(`${LABOUR}${row}\n${PBLOCK}`, 1150, PK)).toBeNull();
  });
});

describe('K-076 r24 HIGH-3 — on an unpaid invoice, a charge the VAT hides or the summary block holds', () => {
  it.each(['Delivery 100.00', 'Call-out 149.00', 'Delivery 50.00', 'Callout R120', 'Parts 1 99.00 99.00',
    'Delivery R 100.00', 'Hire 1 day 120'])('"%s" beside the labour refuses', (row) => {
    expect(refusedBothRoutes(`${LABOUR}${row}\n${PBLOCK}`)).toBe(true);
  });

  it.each([
    'Sub Total 1000.00\nDelivery 350.00\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nDelivery R350\nVAT 15% 150.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nVAT 15% 150.00\nDelivery 350.00\nTOTAL 1150.00',
    'Sub Total 1000.00\nVAT 15% 150.00\nCall-out 100.00\nTOTAL 1150.00',
  ])('a charge inside the summary block refuses: %j', (block) => {
    expect(refusedBothRoutes(`${LABOUR}${block}`)).toBe(true);
  });

  it('a PAID slip is spared both: its payment proves what was owed', () => {
    const paid = `${HDR('Spar')}Bread 100.00\nCard surcharge 5.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`;
    expect(unreconciledFigure(paid, 115, { subtotal: 100, vatAmount: 15 })).toBeNull();
    const mid = `${HDR('Spar')}Bread 100.00\nSub Total 100.00\nRounding 0.05\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`;
    expect(unreconciledFigure(mid, 115, { subtotal: 100, vatAmount: 15 })).toBeNull();
  });

  it('closed in round 25: a row equal to the tax where the rows sum to the total, on an unpaid invoice', () => {
    expect(unreconciledFigure(`${LABOUR}Delivery 150.00\n${PBLOCK}`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}Travel 149.99\n${PBLOCK}`, 1150, PK)).not.toBeNull();
  });
});

describe('K-076 r24 MEDIUM-1 — the COPY and abbreviated reprint footers', () => {
  const makro = (footer: string) => `Makro Woodmead\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 004512\n`
    + `Date: 2026-09-05\nCOFFEE 1KG 189.99\nSub Total 165.21\nVAT 24.78\nTOTAL 189.99\nCARD 189.99\n${footer}`;
  const purchase = (footer: string) => identifiesAsPurchase({ rawText: makro(footer), documentType: 'receipt' });

  it.each(['Copy Receipt', '** COPY RECEIPT **', 'COPY TAX INVOICE', 'Copy 2 of 2', 'Copy No 2', 'COPY - not a tax invoice',
    '** DUP **', 'DUPL.', 'RPRNT', 'HERUITREIKING', 'KOPIEER'])('"%s" refuses', (footer) => {
    expect(purchase(footer)).toBe(false);
  });

  it.each(['CUSTOMER COPY', 'MERCHANT COPY', 'CARDHOLDER COPY', 'Thank you', 'Copy Paper A4 is on special'])(
    '"%s" is not a reprint', (footer) => {
      expect(purchase(footer)).toBe(true);
    });
});
