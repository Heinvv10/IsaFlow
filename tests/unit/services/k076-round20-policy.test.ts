/**
 * Round 20: every exemption must answer "can this ever let money through?".
 *
 * Round 19's counter list matched the END of a label, so `Tip for Server 23`
 * and `Levy per Unit 350` were counts (HIGH-1); its reference-code shape
 * swallowed `TIP-23` and `EFT-1500` (HIGH-2); a figure glued to leader dots was
 * invisible (HIGH-3); and the `of`/mask/unit/street shapes dropped money
 * (MEDIUM-1). Currency (MEDIUM-2) and credit (MEDIUM-3) gaps close, and a second
 * fail-closed gate requires a purchase title. Every input is the reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { namesForeignCurrency } from '@/modules/accounting/services/core/documentCurrency';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const OCEAN = `${HDR('Ocean Basket Sandton')}Hake and Chips 1 200.00 200.00\n`;
const BLOCK = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n';
const K = { subtotal: 200, vatAmount: 30 };
const PLUMB = `${HDR('Joe Plumbing CC')}Labour 1000.00\nSub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n`;
const PK = { subtotal: 1000, vatAmount: 150 };
const SPAR = `${HDR('SPAR')}Bread 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\n`;
const SK = { subtotal: 100, vatAmount: 15 };

describe('K-076 r20 HIGH-1 — a counter label is the WHOLE label', () => {
  it.each(['Admin fee per Invoice 50', 'Levy per Unit 350', 'Handling per Parcel 50', 'Call-out per Branch 350',
    'Cleaning fee per Room 150', 'Printing per Page 5', 'Card surcharge per Transaction 5'])(
    '"%s" on an unpaid invoice is a charge', (line) => {
      expect(unreconciledFigure(`${PLUMB}${line}`, 1150, PK)).not.toBeNull();
    });

  it.each(['Tip for Server 23', 'Tip - Server: 23', 'Gratuity per Table 23', 'Fooi vir Tafel 23',
    'Corkage per Table 50', 'Small Order 25', 'Delivery to Address 35', 'Private Room 150', 'Function Room 500'])(
    '"%s" under CARD 230.00 is a charge', (line) => {
      expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\n${line}`, 230, K)).not.toBeNull();
    });

  it('a charge printed as an item row is extra when the priced rows already add up', () => {
    // 200.00 + 30 lands on the total only because the charge equals the VAT.
    expect(unreconciledFigure(`${OCEAN}Cake cutting per Table 30\n${BLOCK}`, 230, K)).toEqual({ reason: 'stray', value: 30 });
  });

  it.each(['Table 12', 'Your points balance 1250', 'Visit us at Shop 45',
    'Benefit points earned 45', 'Till 04 Cashier 12 Trans 998812', 'Lane 3 Class 1',
    'Bank: FNB Acc 62012345678 Branch 250655'])('"%s" is still a count', (footer) => {
    expect(unreconciledFigure(`${SPAR}${footer}`, 115, SK)).toBeNull();
  });
});

describe('K-076 r20 HIGH-2 — a code prefix is a reference only behind a reference label', () => {
  it.each(['TIP-23', 'TIP/23', 'SVC-23', 'CARD-253', 'VISA-253', 'PAID-253'])('"%s" refuses', (line) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}${line}`, 230, K)).not.toBeNull();
  });

  it.each(['FEE-350', 'CALL-350', 'EFT-1500', 'EFT/1500'])('"%s" on the R1 150 invoice refuses', (line) => {
    expect(unreconciledFigure(`${PLUMB}${line}`, 1150, PK)).not.toBeNull();
  });
});

describe('K-076 r20 HIGH-3 — a figure glued to leader fillers is still a figure', () => {
  it.each(['Call-out fee..........350.00', 'Sundries.......350.00', 'EFT..........1500.00', 'AMOUNT DUE..........1500.00'])(
    '"%s" on the R1 150 invoice refuses', (line) => {
      expect(unreconciledFigure(`${PLUMB}${line}`, 1150, PK)).not.toBeNull();
    });

  it.each(['Waiter..........23.00', 'Service_____23.00', 'CARD............253.00'])('"%s" refuses', (line) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}${line}`, 230, K)).not.toBeNull();
  });

  it('a leader-style slip that reconciles still passes', () => {
    const text = `${HDR('SPAR')}Bread.........100.00\nSub Total.....100.00\nVAT 15%.......15.00\nTOTAL.........115.00\nCARD..........115.00`;
    expect(unreconciledFigure(text, 115, SK)).toBeNull();
  });
});

describe('K-076 r20 MEDIUM-1 — every excluded shape is exact', () => {
  it.each(['Plus call-out fee of 350', 'Excludes call-out of 350', 'EFT of 1500 received',
    'Airport Shuttle 350 One Way', 'Travel 150 km', 'Travel 350 x'])('"%s" on the R1 150 invoice refuses', (line) => {
    expect(unreconciledFigure(`${PLUMB}${line}`, 1150, PK)).not.toBeNull();
  });

  it.each(['Plus tip of 23', 'Gratuity of 23', '**TIP** 23', '*** TIP *** 23', 'Tip ** 23', 'Tip xx 23',
    'Corkage 50 pp', 'Cover charge 50 pp', 'Paid 253 x', 'Paid 253APPROVED', 'CARD 253Approved',
    'Paid 253 One Way', 'Tendered 253 Main St', 'Service 23 x', 'Car guard 23 L', 'Waiter 23 units'])(
    '"%s" refuses', (line) => {
      expect(unreconciledFigure(`${OCEAN}${BLOCK}${line}`, 230, K)).not.toBeNull();
    });

  it.each(['Page 1 of 3', 'VISA **** **** **** 1234', 'Weight 5 kg', 'Warranty valid for 30 days',
    'Returns accepted within 30 days', 'Open 7 days', '12 Main Road', 'Consulting 5 hrs 800.00 800.00'])(
    '"%s" is not money', (footer) => {
      const text = footer.startsWith('Consulting')
        ? `${HDR('ACME')}${footer}\nSub Total 800.00\nVAT 15% 120.00\nTOTAL 920.00\nEFT 920.00`
        : `${SPAR}${footer}`;
      const total = footer.startsWith('Consulting') ? 920 : 115;
      const known = footer.startsWith('Consulting') ? { subtotal: 800, vatAmount: 120 } : SK;
      expect(unreconciledFigure(text, total, known)).toBeNull();
    });
});

describe('K-076 r20 MEDIUM-2 — any currency declaration that is not the rand refuses', () => {
  it.each(['TOTAL 115.00 SR', 'TOTAL 115.00 Rs', 'TOTAL 115,00 kr', 'TOTAL 115.00 Kr', 'TOTAL 115.00 FCFA',
    'TOTAL 115.00 P', 'TOTAL 115.00 zł', 'Currency: MUR', 'Currency code: ZWG', 'Currency: Kwacha',
    'TOTAL 115.00 Kroner', 'TOTAL 115.00 Pesos', 'TOTAL 115.00 Ariary', 'TOTAL 115.00 Dinars',
    'TOTAL 115.00 Rials', 'TOTAL 115.00 Lira', 'TOTAL 115.00 Zloty', 'TOTAL 115.00 Reais',
    'TOTAL 115.00 Rufiyaa', 'TOTAL 115.00 Leones', 'TOTAL 115.00 Rupiah', 'TOTAL 115.00 Won',
    'TOTAL 115.00 Som', 'TOTAL 115.00 Tenge', 'TOTAL 115.00 Forint', 'TOTAL 115.00 Nakfa',
    'Paid in SCR', 'TZS 115.00'])('"%s" refuses', (line) => {
    expect(namesForeignCurrency(`${HDR('ACME')}Widget 100.00\n${line}`)).toBe(true);
  });

  it('a declared currency the lists have never heard of refuses', () => {
    expect(namesForeignCurrency(`${HDR('ACME')}Currency: ZiG\nWidget 100.00\nTOTAL 115.00`)).toBe(true);
  });

  it.each(['Currency: ZAR', 'Currency: Rand', 'Please remit 1150.00 by 30/09/2026', 'Tea 18.00',
    'Congratulations, you won a voucher!', 'Die totale som 115.00 is betaal'])('"%s" is the rand', (line) => {
    expect(namesForeignCurrency(`${HDR('ACME')}${line}`)).toBe(false);
  });
});

describe('K-076 r20 MEDIUM-3 — credit markings, and a second gate that fails closed', () => {
  const G = (marker: string) => `${HDR('GAME')}${marker}\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00`;

  it.each(['TERUGBOEKING', 'OMKERING', 'TRANSAKSIE OMGEKEER', 'GOEDERE TERUGGENEEM', 'TERUGGEBRING',
    'GOEDERE TERUGONTVANG', 'GELD TERUG', 'NIETIG', 'TERUGSKRYWING', 'CHARGEBACK', 'CONTRA', 'KONTRA',
    'RESCINDED', 'NULLIFIED', 'UNDO SALE', 'STORE VOUCHER ISSUED', 'KONTANT TERUG', 'ROLLBACK'])(
    '%s is a credit', (marker) => {
      expect(hasCreditIndicator(G(marker), 499)).toBe(true);
    });

  it('a document with no purchase title refuses, whatever it calls itself — on the AP routes too', () => {
    const letter = 'GAME Stores\nVERGOEDING\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00';
    expect(identifiesAsPurchase({ rawText: letter, documentType: 'invoice' })).toBe(false);
    const doc = { documentType: 'invoice' as const, totalAmount: 499, warnings: [], extractionMethod: 'vlm' as const };
    expect(refusesUnattendedApproval({ ...doc, rawText: letter })).toBe(true);
    expect(refusesUnattendedApproval({ ...doc, rawText: letter.replace('VERGOEDING', 'TAX INVOICE') })).toBe(false);
  });

  it.each(['TAX INVOICE', 'INVOICE', 'RECEIPT', 'TILL SLIP', 'CASH SALE',
    'BELASTINGFAKTUUR', 'KWITANSIE', 'BILL'])('"%s" names a purchase', (title) => {
    expect(identifiesAsPurchase({ rawText: `SPAR\n${title}\nBread 100.00\nTOTAL 115.00`, documentType: 'unknown' })).toBe(true);
  });

  it('a reference line is not a title, and the title must precede the figures', () => {
    expect(identifiesAsPurchase({ rawText: 'ACME\nOriginal Invoice No: 88123\nWidget 100.00\nTOTAL 115.00', documentType: 'invoice' })).toBe(false);
    expect(identifiesAsPurchase({ rawText: 'ACME\nWidget 100.00\nTOTAL 115.00\nTAX INVOICE', documentType: 'invoice' })).toBe(false);
  });

  it('an image with no text passes only on the type the model gave it', () => {
    expect(identifiesAsPurchase({ rawText: '', documentType: 'invoice' })).toBe(true);
    expect(identifiesAsPurchase({ rawText: '', documentType: 'unknown' })).toBe(false);
    expect(identifiesAsPurchase({ rawText: null, documentType: 'credit_note' })).toBe(false);
  });
});

describe('K-076 r20 LOW — markings narrowed where the narrower match holds', () => {
  it.each(["Staan 'n kans om R1000 te wen!", 'Die kans is goed', 'Minus 10% vir pensioenarisse',
    'GRV 12345', '100% money back', 'Money back if not satisfied'])('"%s" is not a credit', (footer) => {
    expect(hasCreditIndicator(`${SPAR}${footer}`, 115)).toBe(false);
  });

  it.each(['KANS', 'MINUS'])('%s alone as a header is still a credit', (marker) => {
    expect(hasCreditIndicator(`${HDR('GAME')}${marker}\nKettle 499.00\nTOTAL 499.00`, 499)).toBe(true);
  });
});
