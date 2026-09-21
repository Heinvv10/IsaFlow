/**
 * Round 22: a count noun no longer exempts its number; the STRUCTURE does.
 *
 * 170 of 174 bare `noun 350` probes posted at `13a26ba1e`: every noun on the
 * count list also names money on some document (`Operator 800` on a plant-hire
 * invoice posted R2 300 against R3 220). So a bare whole number beside a count
 * noun is a count only when BOTH hold: (a) the payments sum exactly to the
 * total — the customer paid this document in full, so the number cannot be an
 * unpaid part of it — and (b) the number is two digits at most and under a
 * tenth of the total. With no payment lines there is no count at all.
 * Plus the round-21 review's LOWs. Every input is the round-21 reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { largerFigureWarning, unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { namesForeignCurrency } from '@/modules/accounting/services/core/documentCurrency';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const LABOUR = `${HDR('Joe Plumbing CC')}Labour 1000.00\n`;
const PBLOCK = 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n';
const PK = { subtotal: 1000, vatAmount: 150 };

/** Every noun and lead the reviewer probed that can open a COUNT label. */
const COUNT_LABELS = ['Items', 'Qty', 'Quantity', 'Units', 'Pieces', 'Parcels', 'Packages', 'Boxes', 'Cartons',
  'Lane', 'Class', 'Till', 'Til', 'Pump', 'Table', 'Tafel', 'Cashier', 'Kassier', 'Operator', 'Op', 'Clerk',
  'Page', 'Bladsy', 'Batch', 'Seq', 'Sequence', 'Store', 'Shop', 'Branch', 'Terminal', 'Trans', 'Transaction',
  'Auth Code', 'Approval Code', 'Seats', 'Guests', 'Pax', 'Covers', 'Points Earned', 'ClubCard Points',
  'Odometer', 'Floor', 'Aisle', 'Serial', 'Version', 'Delivery Items', 'Delivery Boxes', 'Delivery Parcels',
  'Total Items', 'Tax Class', 'VAT Units'];

describe('K-076 r22 HIGH-2 — a bare number beside a count noun is money unless the structure says otherwise', () => {
  it.each(COUNT_LABELS)('"%s 350" refuses above the sub total, after the total, and after a full payment', (noun) => {
    expect(unreconciledFigure(`${LABOUR}${noun} 350\n${PBLOCK}`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${noun} 350`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\n${noun}: 350`, 1150, PK)).not.toBeNull();
  });

  it.each(COUNT_LABELS)('"%s 12" is money on an unpaid invoice, and a count once it was paid in full', (noun) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${noun} 12`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1150.00\n${noun} 12`, 1150, PK)).toBeNull();
  });

  it('(a) the payments must sum EXACTLY to the total', () => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}EFT 1000.00\nItems 12`, 1150, PK)).not.toBeNull();
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}CASH 1200.00\nCHANGE 50.00\nItems 12`, 1150, PK)).toBeNull();
  });

  it('(b) two digits at most, and under a tenth of the total', () => {
    const SPAR = `${HDR('SPAR')}Bread 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\n`;
    const SK = { subtotal: 100, vatAmount: 15 };
    expect(unreconciledFigure(`${SPAR}Table 11`, 115, SK)).toBeNull();
    expect(unreconciledFigure(`${SPAR}Table 12`, 115, SK)).toEqual({ reason: 'stray', value: 12 });
    const BIG = `${HDR('Makro')}TV 10000.00\nSub Total 10000.00\nVAT 15% 1500.00\nTOTAL 11500.00\nCARD 11500.00\n`;
    const BK = { subtotal: 10000, vatAmount: 1500 };
    expect(unreconciledFigure(`${BIG}Items 99`, 11500, BK)).toBeNull();
    expect(unreconciledFigure(`${BIG}Items 100`, 11500, BK)).toEqual({ reason: 'stray', value: 100 });
  });

  it.each([
    ['plant hire', 'Kwena Plant Hire', 'TLB hire 2000.00\nOperator 800\n', 'Sub Total 2000.00\nVAT 15% 300.00\nTOTAL 2300.00', 2300],
    ['yoga', 'Om Studio', 'Mat hire 20.00\nClass 120\n', 'Sub Total 20.00\nVAT 15% 3.00\nTOTAL 23.00\nCARD 23.00', 23],
    ['movers', 'Stuttafords', 'Removal 3000.00\nBoxes 350\n', 'Sub Total 3000.00\nVAT 15% 450.00\nTOTAL 3450.00', 3450],
    ['valet', 'Sparkle Valet', 'Full wash 150.00\nSeats 350\n', 'Sub Total 150.00\nVAT 15% 22.50\nTOTAL 172.50\nCARD 172.50', 172.5],
  ])('the reviewer\'s %s document refuses', (_n, vendor, items, block, total) => {
    expect(unreconciledFigure(`${HDR(vendor)}${items}${block}`, total)).not.toBeNull();
  });

  it('a count larger than the total is warned about at extraction, paid or not', () => {
    const SPAR = `${HDR('Engen')}Fuel 115.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\n`;
    expect(largerFigureWarning(`${SPAR}Odometer 145230`, 115)).not.toBeNull();
    expect(largerFigureWarning(`${SPAR}Pump 5`, 115)).toBeNull();
  });

  it('a number word or a long code still makes a reference, paid or not', () => {
    for (const line of ['Order No 45', 'Receipt No 1234', 'Waybill: TCG-998877', 'Invoice No: TAL-998877']) {
      expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).toBeNull();
    }
  });
});

describe('K-076 r22 — the shape exclusions, each with money beside it', () => {
  it.each(['Date: 2026-09-01 14:22', 'Card ****1234', 'Page 1 of 2', 'Weight 350 kg', 'Payment terms: 30 days',
    'Due in 7 days', 'Est. 1967'])('"%s" on an unpaid invoice is not money', (line) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).toBeNull();
  });

  it.each(['Storage for 350 days', 'Hire for 450 day', 'Standby every 350 hrs', 'Rental period 1500 month',
    'Card ****12345', 'Fee 350 of total', 'Travel 150 km'])('"%s" is money', (line) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).not.toBeNull();
  });
});

describe('K-076 r22 LOW — currency codes that are words, and declarations that are not', () => {
  const doc = (line: string) => `${HDR('ACME')}Widget 100.00\n${line}\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00`;

  it.each(['SHOWER GEL 400ML 39.99', 'HAIR GEL 150ML 44.99', 'AMD RYZEN 5 3600 2499.00', 'TRY OUR NEW MENU',
    'BBQ RUB 250G 49.99', 'Payable in full on receipt', 'Payable in advance', 'Amount in words: one hundred',
    'Payable in 30 days', 'All amounts in Rand', 'Current account'])('"%s" is not foreign', (line) => {
    expect(namesForeignCurrency(doc(line))).toBe(false);
  });

  it.each(['Prices in ZiG', 'Figures in ZiG', 'All amounts shown in ZiG', 'All prices in ZiG', 'Amounts in ZiG',
    'TOTAL GEL 115.00', 'TOTAL 115.00 GEL', 'Paid 115 GEL', 'TOTAL AMD 115', 'Currency: GEL', 'Prices in Lari'])(
    '"%s" refuses', (line) => {
      expect(namesForeignCurrency(doc(line))).toBe(true);
    });
});

describe('K-076 r22 LOW — refund words the list lacked (still a list: fails OPEN, disclosed)', () => {
  const G = (marker: string) => `${HDR('GAME')}${marker}\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00`;

  it.each(['REFND', 'RETRN', 'EXCH', 'XCHG', 'REV SALE', 'RUIL', 'NEG', 'R/N', 'REKLAMASIE', 'RÜCKERSTATTUNG',
    'REMBOURSEMENT', 'RIMBORSO', 'ABONO', 'NOTA DE ABONO', 'ANULACION', 'ANULACIÓN', 'ANULADO'])(
    '%s is a credit', (marker) => {
      expect(hasCreditIndicator(G(marker), 499)).toBe(true);
    });

  it.each(['Exch rate 18.50', 'Ruil binne 7 dae met strokie', 'Omruil slegs met kasstrokie', 'Reklame 2026'])(
    '"%s" is not a credit', (line) => {
      expect(hasCreditIndicator(`${HDR('SPAR')}Milk 115.00\nTOTAL 115.00\nCARD 115.00\n${line}`, 115)).toBe(false);
    });
});
