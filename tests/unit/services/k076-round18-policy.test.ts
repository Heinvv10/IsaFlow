/**
 * Round 18: the whitelist failing open, again, and the price it charged.
 *
 * Round 17 read a whole-rand figure for rule 3 alone, so a whole-rand PAYMENT
 * was excused without ever being summed (HIGH-1); the Pastel `CR` escaped when
 * glued to its figure or printed beside `CARD` on one line, and 21 further
 * markings posted (HIGH-2); and the whole-number reader refused most real till
 * slips over a footer counter (MEDIUM-1). A currency printed after its figure
 * or spelled out escaped (MEDIUM-2), and a summary label explained its figure
 * whatever the value (LOW-1). Every input is one the round-17 reviewer ran.
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { isAmbiguousTotal, unattendedPostingRefusal } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const OCEAN = `${HDR('Ocean Basket Sandton')}Hake and Chips 1 200.00 200.00\n`;
const BLOCK = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n';
const K = { subtotal: 200, vatAmount: 30 };

const refusal = (text: string, total: number, subtotal: number, vat: number) => unattendedPostingRefusal({
  documentType: 'receipt', rawText: text, subtotal, vatAmount: vat, totalAmount: total,
  warnings: [], extractionMethod: 'vlm',
});

describe('K-076 r18 HIGH-1 — one figure reader for all three rules', () => {
  it.each([
    ['a whole-rand card payment larger than the total', `${OCEAN}${BLOCK}Tip: ______\nPaid by card 253`],
    ['a bare whole-rand payment', `${OCEAN}${BLOCK}Paid 253`],
    ['a whole-rand card after a whole-rand charge', `${OCEAN}${BLOCK}Waiter 23 (10%)\nCARD 253`],
    ['a charge and its payment on one line', `${OCEAN}${BLOCK}Waiter 23 CARD 253`],
    ['a tip settled in whole-rand cash', `${OCEAN}${BLOCK}CARD 230.00\nWaiter 23 CASH`],
  ])('%s is SUMMED by rule 1, not excused by rule 3', (_n, text) => {
    expect(unreconciledFigure(text, 230, K)).toEqual({ reason: 'paid', value: 253 });
  });

  it('a plumbing invoice paid by whole-rand EFT for more than its total', () => {
    const text = `${HDR('Joe Plumbing')}Labour 1000.00\nSub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n`
      + 'Call-out fee 350 (after hours)\nEFT 1500';
    expect(unreconciledFigure(text, 1150, { subtotal: 1000, vatAmount: 150 })).toEqual({ reason: 'paid', value: 1500 });
  });

  it.each(['SERVICE:23', 'Service:R23', 'Service 23,-', 'Service 23=', 'Service 23.-', 'Service R23-',
    'SERVICE 23 ZAR'])('%s is read as a figure', (charge) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}${charge}`, 230, K)).toEqual({ reason: 'stray', value: 23 });
  });

  it('a whole-rand charge beside a cents payment on the same line refuses', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}Waiter 23  CARD 230.00`, 230, K)).toEqual({ reason: 'stray', value: 23 });
  });

  it('a whole-rand payable restated larger than the total refuses', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}SERVICE 23\nAMT DUE 253`, 230, K)).not.toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}TOTAL 253`, 230, K)?.value).toBe(253);
  });

  it('a whole-rand charge printed as a LINE ITEM, with nothing paid, refuses on the item sum', () => {
    const text = `${OCEAN}Waiter 23\n${BLOCK}`;
    expect(unreconciledFigure(text, 230, K)).toEqual({ reason: 'stray', value: 23 });
  });

  it('whole-rand item prices that DO add up to the total are an ordinary slip', () => {
    const text = `${HDR('Vida')}Cappuccino 35\nMuffin 30\nSub Total 56.52\nVAT 15% 8.48\nTOTAL 65.00\nCARD 65.00`;
    expect(unreconciledFigure(text, 65, { subtotal: 56.52, vatAmount: 8.48 })).toBeNull();
    expect(unreconciledFigure(text.replace('\nCARD 65.00', ''), 65, { subtotal: 56.52, vatAmount: 8.48 })).toBeNull();
  });

  it('THE TRADE-OFF, pinned: a whole number on its own line under a payment that equals the total is a count', () => {
    // `Table 12`, `Pump 5` and `Car Guard 23` have one shape. Where the
    // payments prove the total is what was paid (the round-16 reviewer scored
    // `Car Guard 23 / … / VISA 230.00` as payable 230), the number is a count.
    // The same line in CENTS is money by its format and still refuses.
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\nCar Guard 23`, 230, K)).toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\nCar Guard 23.00`, 230, K)).not.toBeNull();
  });
});

describe('K-076 r18 MEDIUM-1 — a counter is a labelled small integer, not money', () => {
  const PAID = `${HDR('Pick n Pay')}Milk 115.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\n`;
  const known = { subtotal: 100, vatAmount: 15 };

  it.each(['Items 2', 'No of items: 5', 'ITEMS SOLD 4', 'Qty 3', 'Units 3', 'Lane 3', 'Pump 5', 'Table 12',
    'Covers 2', 'Seat 14', 'Points earned 25', 'Your points balance 1250', 'Seq 4521', 'Cashier 12',
    'Operator 7', 'Terminal 12345', 'Visit us at Shop 45', 'Est. 1967', 'Store 1234', 'Trans 99881',
    'Customer copy 1', 'Page 1 of 1', 'Open 7 days', 'Total Items 5', 'Smart Shopper points 25',
    'Table 12 Covers 2', 'Auth Code 123456', 'Odometer 145230', '14:22 03/09/2026'])(
    'a settled slip with "%s" below it is ordinary', (footer) => {
      expect(unreconciledFigure(`${PAID}${footer}`, 115, known)).toBeNull();
    });

  it('the SAME counter on a document that proves no payment refuses — fail closed', () => {
    const unpaid = `${HDR('Pick n Pay')}Milk 115.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nTable 12`;
    expect(unreconciledFigure(unpaid, 115, known)).toEqual({ reason: 'stray', value: 12 });
  });

  it('a count larger than the total refuses even under a settled payment', () => {
    expect(unreconciledFigure(`${PAID}Batch 123`, 115, known)).toEqual({ reason: 'larger', value: 123 });
  });
});

describe('K-076 r18 HIGH-2 — the Pastel CR against its figure, and the markings', () => {
  const G = (total: string) => `${HDR('GAME')}Kettle 499.00\nSub Total 433.91\nVAT 15% 65.09\n${total}`;

  it.each([
    ['glued to the figure', G('TOTAL 499.00CR\nCARD 499.00')],
    ['glued after a currency mark', G('TOTAL R499.00CR\nCARD 499.00')],
    ['beside CARD on one line', G('TOTAL 499.00 CR  CARD 499.00')],
    ['a minus glued to the currency mark', G('TOTAL -R 499.00\nCARD 499.00')],
  ])('%s is a credit', (_n, text) => {
    expect(hasCreditIndicator(text, 499)).toBe(true);
  });

  it.each(['RFND', 'RFD 0012', 'CANC', 'CNCL', 'RTRN 0012', 'REV 0012', 'CM 0012', 'C/M 0012', 'RMA 0012',
    'CRD NOTE', 'CREDNOTE', 'KRED NOTA', 'KREDITNOTA', 'C.R.', 'C R', 'OMRUILING', 'TERUGBETAALDE',
    'GOEDERE TERUGGESTUUR', 'STORNO', 'GUTSCHRIFT', 'AVOIR'])('%s is a credit', (marker) => {
    expect(hasCreditIndicator(`${HDR('GAME')}${marker}\nKettle 499.00\nTOTAL 499.00\nCARD 499.00`, 499)).toBe(true);
  });

  it.each([
    ['a CR card type', `${HDR('SPAR')}Milk 100.00\nTOTAL 115.00\nCR CARD 115.00`],
    ['a length in centimetres', `${HDR('BUILDERS')}Ruler 30 CM 115.00\nTOTAL 115.00\nCARD 115.00`],
    ['a revision without a number', `${HDR('ACME')}Widget Rev B 115.00\nTOTAL 115.00\nCARD 115.00`],
    ['a creditors heading', `${HDR('ACME')}Creditors Clerk: Thabo\nWidget 115.00\nTOTAL 115.00\nCARD 115.00`],
  ])('%s is not a credit note', (_n, text) => {
    expect(hasCreditIndicator(text, 115)).toBe(false);
  });
});

describe('K-076 r18 MEDIUM-2 — a currency after its figure, or spelled out', () => {
  it.each([
    `${HDR('ACME GmbH')}Software 100,00\nSubtotal 100,00 €\nVAT 0% 0,00 €\nTotal 100,00 €\nReverse charge`,
    `${HDR('ACME')}Software 100.00\nSubtotal 100.00\nVAT 15% 15.00\nTOTAL 115.00 £\nCARD 115.00`,
    `${HDR('ACME')}Premium 100.00\nSubtotal 100.00\nVAT 15% 15.00\nTotal 115.00 (US Dollars)\nCARD 115.00`,
    `${HDR('ACME')}Premium 100.00\nSubtotal 100.00\nVAT 15% 15.00\nTOTAL 115.00 dollars\nCARD 115.00`,
    `${HDR('ACME')}Currency: Dollar\nPremium 100.00\nSubtotal 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`,
  ])('refuses: %#', (text) => {
    expect(isAmbiguousTotal({ rawText: text, warnings: [] })).toBe(true);
  });
});

describe('K-076 r18 LOW-1 — a label explains its figure only at a value consistent with its role', () => {
  it.each(['Total Service 23.00', 'VAT on service 23.00'])('%s below the payment refuses', (line) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\n${line}`, 230, K)).toEqual({ reason: 'stray', value: 23 });
    expect(refusal(`${OCEAN}${BLOCK}CARD 230.00\n${line}`, 230, 200, 30)).not.toBeNull();
  });

  it('a VAT recap at the VAT the reader extracted is still explained', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\nVAT @ 15% 30.00`, 230, K)).toBeNull();
  });

  it.each([
    ['a charge labelled as a recap row', 'VAT ANALYSIS\nStd Rated 207.00\nSERVICE 23.00'],
    ['unlabelled rows that merely sum', 'TAX SUMMARY\n200.00\n7.00\n23.00'],
    ['a charge above a recap row', 'VAT ANALYSIS\nWaiter 23.00\nStd Rated Incl 207.00'],
  ])('%s is not a recap', (_n, block) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\n${block}`, 230, K)).not.toBeNull();
  });

  it('an honest mixed-basket analysis still is', () => {
    const basket = `${HDR('PICK N PAY')}Bread 52.98\nSoap 137.98\nSub Total 165.36\nVAT 15% 25.60\n`
      + 'TOTAL 190.96\nCARD 190.96\nVAT ANALYSIS\nStd Rated Incl 137.98\nZero Rated 52.98';
    expect(unreconciledFigure(basket, 190.96, { subtotal: 165.36, vatAmount: 25.6 })).toBeNull();
  });
});
