/**
 * Round 19: every vocabulary in the gate FAILS CLOSED.
 *
 * A list is acceptable only where a missing entry causes a refusal, never a
 * post. Round 18 had two lists the wrong way round: a whole number no role
 * claimed was a COUNT unless proven otherwise (so a handwritten tip under the
 * card posted the pre-tip total — HIGH-2), and a currency was foreign only if
 * the file knew its name (so `MZN`, `US$`, `Kwacha` posted — MEDIUM-2). A
 * number followed by any word was dropped before its label was read (HIGH-1),
 * and the credit stems could not reach an Afrikaans participle (MEDIUM-1).
 * Every input is one the round-18 reviewer ran.
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { namesForeignCurrency } from '@/modules/accounting/services/core/documentCurrency';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const OCEAN = `${HDR('Ocean Basket Sandton')}Hake and Chips 1 200.00 200.00\n`;
const BLOCK = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n';
const K = { subtotal: 200, vatAmount: 30 };

describe('K-076 r19 HIGH-2 — a tip on the printed blank is money, not a count', () => {
  it.each(['Tip: ____ 23', 'Tip ____ 23', 'Tip:________23', 'Gratuity ___ 23', 'Fooi ___ 23',
    'Waiter tip ____ 23', 'Tip - 23', 'Tip -- 23', 'Tip / 23', 'Tip | 23', 'Tip ~ 23', 'Tip> 23',
    'Gratuity - 23'])('"%s" under CARD 230.00 refuses', (tip) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00\n${tip}`, 230, K)).not.toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}${tip}\nCARD 230.00`, 230, K)).not.toBeNull();
  });

  // Round 21 removed `Address` (`Delivery Address 35` is a charge), so the
  // `Delivery address 12 Main Road` row moved to the round-21 refusals.
  // Round 22: `Till 3 Op 12` (12 is over a tenth of R115) and `Batch 123`
  // (three digits) are no longer counts — see the round-22 policy file.
  it.each(['Items 3', 'Till 3 Op 11', 'Pieces 2', '12 Main Road'])(
    '"%s" is a count or an address, and a settled slip passes', (footer) => {
      const text = `${HDR('SPAR')}Bread 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\n${footer}`;
      expect(unreconciledFigure(text, 115, { subtotal: 100, vatAmount: 15 })).toBeNull();
    });
});

describe('K-076 r19 HIGH-1 — a trailing word does not hide a number from its label', () => {
  it.each(['Paid 253 by card', 'CARD 253 APPROVED', 'Card 253 incl tip', 'Paid 253 (incl tip)',
    'Amount paid 253 incl tip', 'Paid R253 thank you', 'Card R253 approved'])('"%s" is summed', (line) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}${line}`, 230, K)).toEqual({ reason: 'paid', value: 253 });
  });

  const PLUMB = `${HDR('Joe Plumbing CC')}Labour 1000.00\nSub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n`;
  const PK = { subtotal: 1000, vatAmount: 150 };

  it.each(['EFT 1500 received', 'Paid R1500 with thanks', 'EFT R 1 500 received',
    'Payment received: 1500 thank you'])('"%s" on an R1 150 invoice is a disagreeing payment', (line) => {
    expect(unreconciledFigure(`${PLUMB}${line}`, 1150, PK)).toEqual({ reason: 'paid', value: 1500 });
  });

  it.each(['Call-out fee 350 (after hours)', 'Call-out fee 350 excl VAT', 'Plus call-out 350 incl VAT'])(
    '"%s" on an unpaid invoice is an unexplained charge', (line) => {
      expect(unreconciledFigure(`${PLUMB}${line}`, 1150, PK)).toEqual({ reason: 'stray', value: 350 });
    });

  it('a reference code in the header is not an amount (`Invoice No: TAL-998877`)', () => {
    const text = `Takealot\nTAX INVOICE\nInvoice No: TAL-998877\nMouse 1 899.00\nDelivery 60.00\n`
      + 'Sub Total 1 703.48\nVAT 15% 255.52\nTotal 1 959.00';
    expect(unreconciledFigure(text, 1959, { subtotal: 1703.48, vatAmount: 255.52 })).toBeNull();
  });

  it('a unit after a number is a quantity, not money', () => {
    // Round 21: a duration is exempt only after a terms lead, and `Warranty` is
    // no longer a counter (`Warranty 450 month` is a fee).
    expect(unreconciledFigure(`${PLUMB}EFT 1150.00\nPayment terms: 30 days\nWeight 5 kg`, 1150, PK)).toBeNull();
  });
});

describe('K-076 r19 MEDIUM-1 — credit markings the stems could not reach', () => {
  const G = (marker: string) => `${HDR('GAME')}${marker}\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00`;

  it.each(['GEKANSELLEER', 'GEKREDITEER', 'OMGERUIL', 'TERUGGEGEE', 'Geannuleer', 'UITRUIL', 'Kr. Nota',
    'KRNOTA', 'CRN00045', 'CN0012', 'KN00123', 'RVSL', 'REVSL', 'RET 0012', 'RETD', "RET'D", 'REFD 0012',
    'RA 0012', 'CXL', 'CNX', 'RTV 0012', 'ANNULLED', 'REVERSE SALE', 'NEG SALE', '-VE SALE', 'ADJ NOTE',
    'Adj. note', 'Reimbursement', 'Rückgabe', 'VD 0012', 'MONEY BACK', 'KANS', 'MINUS'])(
    '%s is a credit', (marker) => {
      expect(hasCreditIndicator(G(marker), 499)).toBe(true);
    });

  it.each([['lowercase glued cr', 'TOTAL 499.00cr.'], ['Afrikaans Kt beside the total', 'TOTAL 499.00 KT']])(
    '%s is a credit', (_n, total) => {
      expect(hasCreditIndicator(`${HDR('GAME')}Kettle 499.00\n${total}`, 499)).toBe(true);
    });

  it('a money-back guarantee is a promise, not a refund', () => {
    expect(hasCreditIndicator(`${HDR('GAME')}Kettle 499.00\nTOTAL 499.00\nCARD 499.00\nMoney back guarantee`, 499)).toBe(false);
  });
});

describe('K-076 r19 MEDIUM-2 — a currency passes only when it is the rand', () => {
  it.each(['TOTAL 115.00 US$', 'TOTAL 115.00 MZN', 'TOTAL 115.00 MT', 'TOTAL 115.00 Pula',
    'TOTAL 115.00 Kwacha', 'TOTAL 115.00 Rupees', 'TOTAL 115.00 Meticais', 'TOTAL 115.00 Dirham',
    'TOTAL N$ 115.00', 'TOTAL 115.00 XYZ'])('"%s" refuses', (line) => {
    expect(namesForeignCurrency(`${HDR('ACME')}Widget 100.00\nVAT 15.00\n${line}`)).toBe(true);
  });

  it.each(['TOTAL R 115.00', 'TOTAL 115.00 ZAR', 'TOTAL ZAR 115.00', 'VAT 15.00', 'EFT 115.00',
    'MILK 32.99 A', 'DIESEL 50PPM 52.10 L'])('"%s" is the rand, or not a currency at all', (line) => {
    expect(namesForeignCurrency(`${HDR('ACME')}${line}`)).toBe(false);
  });
});
