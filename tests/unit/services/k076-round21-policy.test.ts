/**
 * Round 21: an exemption list may only hold an entry whose money-beside probe
 * still refuses — and that probe is recorded here, next to the entry.
 *
 * Round 20 added twelve counter nouns (`Mileage`, `Warranty`, `Quote`,
 * `Ticket`…) without that check, and every one of them named money on an
 * ordinary invoice (HIGH-1). A duration was exempt anywhere, so a RATE posted
 * (`Hire 450 day`, MEDIUM-1). Refund words under a TAX INVOICE header posted
 * (MEDIUM-2). Titles with a number or a second language refused (LOW-1, LOW-2);
 * three currency shapes posted (LOW-4). Every input is the round-20 reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { namesForeignCurrency } from '@/modules/accounting/services/core/documentCurrency';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const OCEAN = `${HDR('Ocean Basket Sandton')}Hake and Chips 1 200.00 200.00\n`;
const BLOCK = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n';
const K = { subtotal: 200, vatAmount: 30 };
const LABOUR = `${HDR('Joe Plumbing CC')}Labour 1000.00\n`;
const PBLOCK = 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n';
const PK = { subtotal: 1000, vatAmount: 150 };

/** Every noun still on the COUNT list — each must carry its money-beside probe. */
const COUNT_NOUNS = ['Items', 'Qty', 'Quantity', 'Units', 'Pieces', 'Parcels', 'Packages', 'Boxes', 'Cartons',
  'Lane', 'Class', 'Till', 'Pump', 'Table', 'Tafel', 'Cashier', 'Kassier', 'Operator', 'Op', 'Clerk', 'Page',
  'Bladsy', 'Batch', 'Seq', 'Store', 'Shop', 'Branch', 'Terminal', 'Trans', 'Auth Code', 'Approval Code',
  'Seats', 'Guests', 'Pax', 'Points Earned', 'Points Balance', 'ClubCard Points', 'Odometer', 'Floor', 'Aisle',
  'Serial', 'Version'];

describe('K-076 r21 — the money-beside probe for every surviving COUNT noun', () => {
  it.each(COUNT_NOUNS)('"%s" with a charge word beside it, or a cents figure, is money', (noun) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\n${noun} fee 23`, 230, K)).not.toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\n${noun} 23.00`, 230, K)).not.toBeNull();
  });
});

describe('K-076 r21 HIGH-1 — the twelve nouns round 20 added are money again', () => {
  const REMOVED = ['Mileage', 'Warranty', 'Guarantee', 'Ticket', 'Quote', 'Quotation', 'Job', 'Tracking',
    'Waybill', 'Consignment', 'Docket', 'Distance', 'Duration', 'Weight', 'Terms', 'Validity'];

  it.each(REMOVED)('"%s 350" as an item row above the sub total refuses', (noun) => {
    expect(unreconciledFigure(`${LABOUR}${noun} 350\n${PBLOCK}`, 1150, PK)).not.toBeNull();
  });

  it.each(REMOVED)('"%s 350" after the total, paid or not, refuses', (noun) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${noun} 350`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\n${noun}: 350`, 1150, PK)).not.toBeNull();
  });

  // `Covers` went back to the COUNT nouns in round 22, where a count needs a
  // document paid in full and a small number (the round-22 policy file).
  it.each(['Receipt 1500', 'Account 1500', 'Acc: 1500', 'Room 350', 'Order 35', 'Server 23',
    'Code 23', 'Customer Copy 23', 'Delivery Address 35', 'Loyalty Points 23', 'Points 23'])(
    'a noun that can name money is money without a number word: "%s"', (line) => {
      expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\n${line}`, 1150, PK)).not.toBeNull();
    });

  it.each(['Order No 45', 'Receipt No 1234', 'Waybill: TCG-998877', 'Invoice No: TAL-998877'])(
    'with a number word or a long code it is a reference: "%s"', (line) => {
      expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\n${line}`, 1150, PK)).toBeNull();
    });

  it.each(['Receipt No: CASH-1500', 'Invoice No: CO-350', 'Ref: TIP-350'])(
    'a short code behind a reference label is money: "%s"', (line) => {
      expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).not.toBeNull();
    });

  it('a measurement is a measurement; a measure alone is a charge', () => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\nWeight 5 kg\nDistance 12 km`, 1150, PK)).toBeNull();
    // The money-beside probe for the measurement rule: still a weight.
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\nWeight 350 kg`, 1150, PK)).toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}Travel 150 km`, 1150, PK)).not.toBeNull();
  });
});

describe('K-076 r21 MEDIUM-1 — a duration is exempt only after a terms lead', () => {
  it.each(['Hire 450 day', 'Rent 1500 month', 'Storage 200 month', 'Standby 350 hour', 'Labour 450 hr',
    'Extra 350 hrs', 'Overtime 350 uur'])('a RATE "%s" refuses', (line) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).not.toBeNull();
  });

  it.each(['Parking 30 min', 'Waiter 23 hrs'])('"%s" on a slip refuses', (line) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\n${line}`, 230, K)).not.toBeNull();
  });

  it.each(['Payment terms: 30 days', 'Returns accepted within 30 days', 'Open 7 days', 'Valid for 30 days',
    'Terms: net 30 days'])('"%s" is a term, not money', (line) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\n${line}`, 1150, PK)).toBeNull();
  });
});

describe('K-076 r21 MEDIUM-2 — refund words printed under a TAX INVOICE header', () => {
  const G = (marker: string) => `${HDR('GAME')}${marker}\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00`;

  it.each(['DEVOLUÇÃO', 'DEVOLUCAO', 'REEMBOLSO', 'ESTORNO', 'TERUGSENDING', 'TERUGVORDERING',
    'GOEDERE ONTVANG TERUG', 'BUY BACK', 'BUYBACK', 'TRADE IN', 'PAID OUT', 'CASH OUT', 'REPAID', 'REPAYMENT',
    'RECLAIM', 'PRICE ADJUSTMENT', 'PRICE CORRECTION', 'GOODWILL', 'COMPENSATION', 'CUSTOMER CLAIM', 'MISRING',
    'OVERRING', 'SALE CORRECTED', 'ERROR CORRECTION', 'PAYOUT', 'TERUG'])('%s is a credit', (marker) => {
    expect(hasCreditIndicator(G(marker), 499)).toBe(true);
  });

  it('TERUG in prose is not a credit', () => {
    expect(hasCreditIndicator(`${HDR('SPAR')}Milk 115.00\nTOTAL 115.00\nCARD 115.00\nKom gerus terug!`, 115)).toBe(false);
  });
});

describe('K-076 r21 LOW-1/LOW-2 — a title may carry its number, a second language, a date above it', () => {
  const doc = (title: string, above = 'SPAR Rivonia') =>
    ({ rawText: `${above}\n${title}\nBread 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00`, documentType: 'unknown' as const });

  // Round 22: a line carrying a number is a field, never a title, and a
  // STATEMENT anywhere in the header refuses — see the round-22 policy file.
  it.each(['TAX INVOICE / BELASTINGFAKTUUR', 'BELASTINGFAKTUUR / TAX INVOICE', 'Tax Invoice Original', 'TILL RECEIPT',
    'CUSTOMER RECEIPT', 'SALES INVOICE', 'Retail Invoice', 'CASH SLIP', 'INVOICE / RECEIPT',
    'TAX INVOICE Page 1 of 1', 'PARKING RECEIPT'])(
    '"%s" names a purchase', (title) => {
      expect(identifiesAsPurchase(doc(title))).toBe(true);
    });

  it.each(['SPAR Rivonia\n10.09.26 14:32', 'SPAR Rivonia\nTime 14.32', 'SPAR Rivonia\nTel 011 555 1234'])(
    'a date, a time or a phone above the title does not end the header', (above) => {
      expect(identifiesAsPurchase(doc('TAX INVOICE', above))).toBe(true);
    });

  it.each(['TAX INVOICE (COPY)', 'COPY TAX INVOICE', 'TAX INVOICE - COPY', 'TAX INVOICE COPY',
    'TAX INVOICE (REPRINT)', 'DUPLICATE TAX INVOICE', 'Original Invoice No: 88123'])(
    '"%s" is NOT a title — a reprint of a captured slip is a double post', (title) => {
      expect(identifiesAsPurchase(doc(title))).toBe(false);
    });

  it('a goods-received voucher in the header refuses, beside a RECEIPT or a TAX INVOICE (round 22)', () => {
    expect(identifiesAsPurchase(doc('RECEIPT', "Bob's Hardware\nGRV No: 0012345"))).toBe(false);
    expect(identifiesAsPurchase(doc('TAX INVOICE', 'Metro\nGRV No: 0012345'))).toBe(false);
  });

  it('a number beside a title word is read as money unless a number word says it is an id (round 22)', () => {
    const body = 'Bread 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00';
    const SK = { subtotal: 100, vatAmount: 15 };
    // Round 21 made a title line's number the document's; round 22 removed the
    // rule with the numbered title, so `TAX INVOICE: 12345` is money again.
    expect(unreconciledFigure(`SPAR\nTAX INVOICE: 12345\n${body}`, 115, SK)).not.toBeNull();
    expect(unreconciledFigure(`SPAR\nTAX INVOICE No 12345\n${body}`, 115, SK)).toBeNull();
    expect(unreconciledFigure(`SPAR\nTAX INVOICE\n${body}\nTAX INVOICE: 1500`, 115, SK)).not.toBeNull();
    expect(unreconciledFigure(`SPAR\nTAX INVOICE\n${body}\nRECEIPT 1500`, 115, SK)).not.toBeNull();
  });
});

describe('K-076 r21 LOW-4 — currency', () => {
  it.each(['TOTAL Rs 115.00', 'TOTAL Rp 115.00', 'TOTAL 115.00 Zimbabwe Gold', 'All amounts in MVR',
    'Payable in US funds', 'TOTAL 115.00 Dalasi', 'Amounts in USD', 'CCY - USD',
    // Only the "amounts in" declaration can catch this one: ZiG is on no list.
    'All amounts in ZiG'])('"%s" refuses', (line) => {
    expect(namesForeignCurrency(`${HDR('ACME')}Widget 100.00\n${line}`)).toBe(true);
  });

  it.each(['Amount Incl VAT 1150.00', 'All amounts in Rand', 'Payable in 30 days'])('"%s" is not foreign', (line) => {
    expect(namesForeignCurrency(`${HDR('ACME')}${line}`)).toBe(false);
  });
});
