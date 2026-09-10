/**
 * Round 16: auto-posting becomes a WHITELIST, measured over the whole document.
 *
 * Seven rounds were beaten by rules that read a POSITION. Round 15's tender
 * arithmetic read only the text below the printed total, so a split tender
 * printed ABOVE the total block (HIGH-1) was never examined, a charge printed
 * BELOW the tender line (LOW-1) was skipped once a tender had been found, and
 * a payment rail missing from `TENDER_LABEL` simply dropped out of the sum
 * (MEDIUM-2). The credit rule was still a word list, and thirteen ordinary SA
 * abbreviations of "credit note" walked through it (HIGH-2).
 *
 * A document may now auto-post only when everything reconciles: the payments
 * sum to the total, nothing is larger than the total, and nothing below the
 * total block is unexplained. Every input below is one the round-15 reviewer
 * measured on `8cda2e5e4`.
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { isCreditNote, unattendedPostingRefusal } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\n`;
const OCEAN = `${HDR('Ocean Basket Sandton')}Hake and Chips 1 200.00 200.00\n`;
const BLOCK = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n';

const refusal = (text: string, total: number, subtotal: number, vat: number) => unattendedPostingRefusal({
  documentType: 'receipt', rawText: text, subtotal, vatAmount: vat, totalAmount: total,
  warnings: [], extractionMethod: 'vlm',
});

describe('K-076 r16 HIGH-1 — a split tender printed ABOVE the total', () => {
  it('is examined, because the arithmetic reads the whole document', () => {
    const text = `${OCEAN}VISA 126.50\nMASTERCARD 126.50\n${BLOCK}`;
    expect(unreconciledFigure(text, 230)).toEqual({ reason: 'paid', value: 253 });
    expect(refusal(text, 230, 200, 30)).toBe('the document was paid 253.00, not the total read');
  });

  it('the same slip with a single tender above the total still refuses', () => {
    expect(unreconciledFigure(`${OCEAN}VISA 253.00\n${BLOCK}`, 230)?.value).toBe(253);
  });

  it('a tender printed above the total that AGREES with it does not refuse', () => {
    expect(unreconciledFigure(`${OCEAN}VISA 230.00\n${BLOCK}`, 230)).toBeNull();
  });
});

describe('K-076 r16 LOW-1 — a charge printed BELOW the tender line', () => {
  it.each(['Car Guard', 'Packer', 'Trolley', 'Bag Levy', 'Waiter', 'Tronc', 'Freight',
    'Courier', 'Handling', 'Surcharge', 'Levy', 'Shipping', 'Admin', 'Booking'])('%s', (charge) => {
    const text = `${OCEAN}${BLOCK}VISA 230.00\n${charge} 23.00`;
    expect(unreconciledFigure(text, 230))
      .toEqual({ reason: 'stray', value: 23 });
  });
});

describe('K-076 r16 MEDIUM-2 — a payment rail the vocabulary does not know', () => {
  const RAILS = ['Ozow', 'PayShap', 'Capitec Pay', 'Apple Pay', 'Samsung Pay', 'Mobile Money',
    'eBucks', 'Discovery Miles', 'UCount Points', 'SCode', 'Instant EFT', 'Nedbank Money',
    'Store Account', 'Staff Account', 'Loyalty', 'Points Redeemed', 'FNB Pay', 'Scan to Pay'];

  it.each(RAILS)('a charge settled on a second leg named %s refuses either way', (rail) => {
    // Recognised, the sum disagrees; unrecognised, the charge is left
    // unexplained below the total. The vocabulary cannot cost money here.
    const text = `${OCEAN}${BLOCK}SERVICE 23.00\nVISA 230.00\n${rail} 23.00`;
    expect(unreconciledFigure(text, 230)).not.toBeNull();
    expect(refusal(text, 230, 200, 30)).not.toBeNull();
  });

  it.each(['OZOW', 'ZAPPER', 'GIFT CARD', 'STAFF ACCOUNT'])('%s paying the whole total is ordinary', (rail) => {
    const text = `${HDR('CAFE')}Coffee 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\n${rail} 115.00`;
    expect(unreconciledFigure(text, 115)).toBeNull();
  });

  it('a loyalty split is a payment on both legs, not an over-refusal', () => {
    const text = `${HDR('CAFE')}Coffee 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nPOINTS 15.00\nCARD 100.00`;
    expect(unreconciledFigure(text, 115)).toBeNull();
  });

  it('a payment word that is not labelling the figure beside it is not a payment', () => {
    // `Credit card surcharge 5.00`, `points balance 1 250.00` and a mouse
    // called `MX Master 3S` were all summed as payments before r16.
    const surcharge = `${HDR('SPAR')}Milk 100.00\nCredit card surcharge 5.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`;
    expect(unreconciledFigure(surcharge, 115)).toBeNull();
    const mouse = `${HDR('TAKEALOT')}1 Logitech MX Master 3S 1 899.00\nDelivery 60.00\nSub Total 1 703.48\nVAT 15% 255.52\nTotal 1 959.00`;
    expect(unreconciledFigure(mouse, 1959)).toBeNull();
  });
});

describe('K-076 r16 — nothing below the total block may be unexplained', () => {
  it('a VAT recap or a tax-analysis block IS explained by the net and the tax', () => {
    const recap = `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\nVAT @ 15% 15.00`;
    // Round 18 (LOW-1): a summary line explains its figure only when the figure
    // IS the net, the tax or the total — so the extracted amounts are passed.
    expect(unreconciledFigure(recap, 115, { subtotal: 100, vatAmount: 15 })).toBeNull();
    const analysis = `${HDR('ACME')}Widget 1000.00\nSub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\nVAT SUMMARY\nRate Net VAT\n15% 1000.00 150.00`;
    expect(unreconciledFigure(analysis, 1150, { subtotal: 1000, vatAmount: 150 })).toBeNull();
  });

  it('an amount-due box repeated in the header does not make the line items strays', () => {
    const text = `${HDR('ACME')}AMOUNT DUE 1150.00\nWidget 1 1000.00 1000.00\nSub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00`;
    expect(unreconciledFigure(text, 1150)).toBeNull();
    // The BOTTOM occurrence ends the total block. Keyed off the first, every
    // line item below the header box would have to be explained, and a basket
    // of two items — neither of them the net or the tax — could not be.
    const basket = `${HDR('ACME')}AMOUNT DUE 1150.00\nWidget 1 400.00 400.00\nGadget 1 600.00 600.00\n`
      + 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00';
    expect(unreconciledFigure(basket, 1150)).toBeNull();
  });

  it('a figure larger than the total that no payment explains is its own refusal', () => {
    // The payment is printed on a continuation line, so nothing labels the
    // amount; it is simply bigger than the total the reader chose.
    const text = `${OCEAN}${BLOCK}VISA\n**** 1234   253.00`;
    expect(unreconciledFigure(text, 230))
      .toEqual({ reason: 'larger', value: 253 });
  });

  it('a part payment leaves a balance the reader cannot call the total', () => {
    const text = `${HDR('ACME')}Sub Total 5000.00\nVAT 15% 750.00\nTOTAL 5750.00\nDeposit Paid 2000.00\nBalance 3750.00`;
    expect(unreconciledFigure(text, 5750)).not.toBeNull();
  });
});

describe('K-076 r16 HIGH-2 — a credit note abbreviated', () => {
  const K = (marker: string) => `${HDR('GAME')}${marker}\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00`;

  it.each(['CR NOTE 0012', 'Cr Note No 0012', 'C/N 0012', 'CRN 0012', 'CR/NOTE 0012', 'RETOUR',
    'TAX INVOICE (CR)', 'ADJUSTMENT NOTE', 'DEBIT NOTE', 'CANX', 'CANX SALE', 'RTN SLIP',
    'R/A 0012', 'MERCHANDISE RETURN'])('%s is a credit', (marker) => {
    expect(hasCreditIndicator(K(marker), 499)).toBe(true);
  });

  it.each([
    ['a credit note split across a line break', `${HDR('GAME')}CREDIT\nNOTE 0012\nKettle 499.00\nVAT 65.09\nTOTAL 499.00`],
    ['a hyphenated Afrikaans credit note', `${HDR('GAME')}KREDIET-\nNOTA 0012\nKetel 499.00\nBTW 65.09\nTOTAAL 499.00`],
    ['TERUGBETAL1NG as the scanner read it', `${HDR('GAME')}TERUGBETAL1NG\nKetel 499.00\nBTW 65.09\nTOTAAL 499.00`],
    ['RET0ER as the scanner read it', `${HDR('GAME')}RET0ER SLIP 0012\nKetel 499.00\nBTW 65.09\nTOTAAL 499.00`],
  ])('%s', (_n, text) => {
    expect(hasCreditIndicator(text, 499)).toBe(true);
  });
});

describe('K-076 r16 — who the document is FROM is not what it is', () => {
  it.each([
    ['a supplier called Credit Solutions SA', 'Credit Solutions SA'],
    ['a supplier called Refund Recovery Services', 'Refund Recovery Services'],
    ['a supplier called The Exchange Trading Co', 'The Exchange Trading Co'],
  ])('%s is an ordinary purchase', (_n, vendor) => {
    const text = `${HDR(vendor)}Widget 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`;
    expect(hasCreditIndicator(text, 115, [vendor])).toBe(false);
  });

  it('an address containing a credit word is scrubbed the same way', () => {
    const address = 'Shop 5, The Exchange, Sandton';
    const text = `${HDR('ACME')}${address}\nWidget 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`;
    expect(hasCreditIndicator(text, 115, [null, address])).toBe(false);
    expect(hasCreditIndicator(text, 115, [])).toBe(true);
  });

  it('a CREDIT NOTE printed BY that supplier still refuses', () => {
    const vendor = 'Credit Solutions SA';
    const text = `${HDR(vendor)}CREDIT NOTE No CN0012\nWidget 100.00\nTOTAL 115.00`;
    expect(hasCreditIndicator(text, 115, [vendor])).toBe(true);
  });
});

describe('K-076 r16 — the everyday policy footers that are not credits', () => {
  it.each([
    'Goods returned must be in original packaging',
    'Please retain this slip for returns',
    'Faulty goods will be exchanged',
    'Return to any store with this slip',
    'VOID IF ALTERED',
    'Credit Guarantee Insurance Corp',
  ])('%s', (footer) => {
    const text = `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\n${footer}`;
    expect(hasCreditIndicator(text, 115)).toBe(false);
  });

  it('a late cancellation fee is a charge, not a cancelled sale', () => {
    const text = `${HDR('HOTEL')}Late Cancellation Fee 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`;
    expect(hasCreditIndicator(text, 115)).toBe(false);
  });

  it('a bare GOODS RETURNED header is still a credit', () => {
    const text = `${HDR('GAME')}GOODS RETURNED\nKettle 499.00\nTOTAL 499.00`;
    expect(hasCreditIndicator(text, 499)).toBe(true);
  });
});

describe('K-076 r16 — a negative VLM total is a classification, not a figure', () => {
  it('a stored negative total is still refused as a credit', () => {
    expect(isCreditNote({ documentType: 'invoice', rawText: 'Widget 100.00\nTOTAL 115.00', totalAmount: -115 })).toBe(true);
  });

  it('a credit note the model reported negative is stored positive and typed', () => {
    expect(isCreditNote({ documentType: 'credit_note', rawText: 'Widget 100.00\nTOTAL 115.00', totalAmount: 115 })).toBe(true);
  });
});
