/**
 * Round 17: the whitelist failing OPEN, closed five ways.
 *
 * Every round-16 finding was the same defect wearing a different hat — a rule
 * that could not SEE something, and therefore let it through:
 *   - a charge printed without cents was not a figure at all, so all three
 *     rules skipped it and `ADDITION_LABEL` was the only guard left on the
 *     shape the file's own argument says a vocabulary cannot cover (HIGH-1);
 *   - the credit markings skipped `ocrTolerant` and omitted the Sage/Pastel
 *     `CR`, so `CR N0TE 0012` escaped while `CRED1T N0TE` refused (HIGH-2);
 *   - rule 3 explained a figure by its VALUE, so a charge that coincided with
 *     the tax, the net or the total was waved through (MEDIUM-1);
 *   - "no total could be read" was treated as "nothing to choose between", and
 *     a USD invoice auto-approved at 115.00 against R2 116.00 (MEDIUM-2);
 *   - rule 2 forgave every payment figure, not only one a BALANCED payment sum
 *     accounted for (LOW-1).
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { isAmbiguousTotal, unattendedPostingRefusal } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\n`;
const OCEAN = `${HDR('Ocean Basket Sandton')}Hake and Chips 1 200.00 200.00\n`;
const BLOCK = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n';

const refusal = (text: string, total: number, subtotal: number, vat: number) => unattendedPostingRefusal({
  documentType: 'receipt', rawText: text, subtotal, vatAmount: vat, totalAmount: total,
  warnings: [], extractionMethod: 'vlm',
});

const CHARGES = ['SERVICE', 'Car Guard', 'Waiter', 'Packer', 'Tronc', 'Bag Levy', 'Freight',
  'Handling', 'Surcharge', 'Levy', 'Admin Fee', 'Booking Fee', 'Corkage', 'Cover Charge'];

describe('K-076 r17 HIGH-1 — a charge printed WITHOUT cents', () => {
  it.each(CHARGES)('%s 23 with a whole-rand payable restated', (charge) => {
    const text = `${OCEAN}${BLOCK}${charge} 23\nAMT DUE 253`;
    expect(unreconciledFigure(text, 230)).not.toBeNull();
    expect(refusal(text, 230, 200, 30)).not.toBeNull();
  });

  it.each(CHARGES)('%s 23 with a whole-rand card tender', (charge) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}${charge} 23\nCARD 253`, 230)).not.toBeNull();
  });

  it('the same slip with cents refused before this round and still does', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}SERVICE 23.00\nAMT DUE 253.00`, 230)).not.toBeNull();
  });

  it('a whole-rand charge with no restated payable at all is seen', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}SERVICE 23`, 230)).toEqual({ reason: 'stray', value: 23 });
  });

  it('an ordinary slip is not refused by the noise a whole number brings', () => {
    // Each of these prints a whole number below its total that is NOT an
    // amount, and each measured a refusal while the pattern was looser.
    const cases = [
      `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00\nGoods may be returned in 7 days`,
      `${HDR('WALTONS')}Copy Paper 1 1000.00 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00\nDelivery Note No: DN4471`,
      // Round 22: `Branch 250655` dropped — on an unpaid invoice it is money.
      `${HDR('ACME')}Widget 1000.00\nSub Total 1000.00\nVAT 150.00\nTotal 1150.00\nBanking: FNB Acc 62012345678`,
      `${HDR('SHELL')}Diesel 1 140.47\nTOTAL 1 140.47\nVAT 0.00\nFleet card R 1 140.47`,
      `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nVISA CREDIT 115.00`,
    ];
    for (const text of cases) expect(unreconciledFigure(text, text.includes('1 140') ? 1140.47 : (text.includes('1150') ? 1150 : 115))).toBeNull();
  });
});

describe('K-076 r17 HIGH-2 — the credit markings', () => {
  const K = (marker: string) => `${HDR('GAME')}${marker}\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00`;

  it.each(['CN 0012', 'KN 0012', 'K/N 0012', 'OMRUIL', 'TERUGGAWE', 'TERUGSTUUR', 'GOEDERE TERUG',
    'KORREKSIE', 'ALLOWANCE NOTE', 'REBATE NOTE', 'REBATE', 'CLAIM NOTE', 'CORRECTION SLIP',
    'NEGATIVE SALE', 'MINUS SALE', 'NO SALE'])('%s is a credit', (marker) => {
    expect(hasCreditIndicator(K(marker), 499)).toBe(true);
  });

  it.each(['Doc Type: CR', 'Type: CR'])('%s is a credit', (marker) => {
    expect(hasCreditIndicator(K(marker), 499)).toBe(true);
  });

  it('the Sage/Pastel CR printed AFTER the total is a credit', () => {
    const text = `${HDR('GAME')}Kettle 499.00\nSub Total 433.91\nVAT 15% 65.09\nTOTAL 499.00 CR\nCARD 499.00`;
    expect(hasCreditIndicator(text, 499)).toBe(true);
  });

  it.each(['CR N0TE 0012', 'CR NOTE 0012', 'CRN 0012', 'RETURH SLIP 0012', 'C/H 0012'])(
    'the markings go through ocrTolerant as the words do: %s', (marker) => {
      expect(hasCreditIndicator(K(marker), 499)).toBe(true);
    });

  it.each([
    ['a CR card type', `${HDR('SPAR')}Milk 100.00\nTOTAL 115.00\nCR CARD 115.00`],
    ['a card marked DR', `${HDR('SPAR')}Milk 100.00\nTOTAL 115.00\nCARD DR 115.00`],
    ['an account type', `${HDR('SPAR')}Milk 100.00\nTOTAL 115.00\nCARD 115.00\nAcc Type: CREDIT`],
  ])('%s is not a credit note', (_n, text) => {
    expect(hasCreditIndicator(text, 115)).toBe(false);
  });
});

describe('K-076 r17 MEDIUM-1 — explained by ROLE, never by a coincidence of value', () => {
  const S = (line: string) => `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\n${line}`;

  it.each([
    ['a charge equal to the VAT', 'SERVICE 15.00', 15],
    ['a charge equal to the net', 'Car Guard 100.00', 100],
    ['a charge equal to the total', 'Second table 115.00', 115],
  ])('%s is not explained', (_n, line, value) => {
    expect(unreconciledFigure(S(line), 115)).toEqual({ reason: 'stray', value });
    expect(refusal(S(line), 115, 100, 15)).toBe(`the document prints ${value.toFixed(2)} below its total, which nothing explains`);
  });

  // Round 18 (LOW-1) made the value part of the role, so these pass the
  // extracted net and tax, as the gate does.
  const K = { subtotal: 100, vatAmount: 15 };

  it('a line that says what its figure IS stays explained', () => {
    expect(unreconciledFigure(S('CARD 115.00'), 115, K)).toBeNull();
    expect(unreconciledFigure(S('VAT @ 15% 15.00'), 115, K)).toBeNull();
    expect(unreconciledFigure(S('Sub Total 100.00'), 115, K)).toBeNull();
    expect(unreconciledFigure(S('Amount Due 115.00'), 115, K)).toBeNull();
    expect(unreconciledFigure(S('Balance 0.00'), 115, K)).toBeNull();
  });

  it('a recap block explains rows that carry no label of their own', () => {
    expect(unreconciledFigure(S('CARD 115.00\nVAT ANALYSIS\nA 15.00% 100.00 15.00'), 115, K)).toBeNull();
    expect(unreconciledFigure(S('CARD 115.00\nBTW OPSOMMING\n15% 100.00 15.00'), 115, K)).toBeNull();
    // …and only BELOW its own header: the same rows without one refuse.
    expect(unreconciledFigure(S('CARD 115.00\nA 15.00% 100.00 15.00'), 115, K)).not.toBeNull();
  });

  it('a mixed-basket VAT analysis is explained by its own arithmetic, not its header', () => {
    const basket = `${HDR('PICK N PAY')}Bread 52.98\nSoap 137.98\nSub Total 165.36\nVAT 15% 25.60\n`
      + 'TOTAL 190.96\nCARD 190.96\nVAT ANALYSIS\nStd Rated Incl 137.98\nZero Rated 52.98';
    expect(unreconciledFigure(basket, 190.96)).toBeNull();
    // A charge printed inside the block breaks the block's sum, so a header
    // cannot be used to smuggle one past rule 3.
    const smuggled = `${HDR('SPUR')}Burger 200.00\nSub Total 200.00\nVAT 15% 30.00\nTOTAL 230.00\nCARD 230.00\n`
      + 'VAT ANALYSIS\nStd Rated Incl 230.00\nSERVICE 23.00';
    expect(unreconciledFigure(smuggled, 230)).not.toBeNull();
  });

  it('a debit order, a stop order and a remittance instruction are payments', () => {
    const invoice = (line: string) => `${HDR('Telkom SA')}Fibre 999.00\nSub Total 999.00\nVAT 15% 149.85\nTOTAL 1148.85\n${line}`;
    expect(unreconciledFigure(invoice('Debit Order 1148.85'), 1148.85)).toBeNull();
    expect(unreconciledFigure(invoice('Stop Order 1148.85'), 1148.85)).toBeNull();
    expect(unreconciledFigure(invoice('Please remit 1148.85 by 30/09/2026'), 1148.85)).toBeNull();
    // …and a remittance for a DIFFERENT amount is a payment that disagrees.
    expect(unreconciledFigure(invoice('Please remit 1200.00 by 30/09/2026'), 1148.85)?.reason).toBe('paid');
  });
});

describe('K-076 r17 MEDIUM-2 — no readable total, and a foreign currency', () => {
  const USD = `${HDR('ACME')}Widget 115.00\nTOTAL USD 115.00\nZAR 2116.00\nCARD 2116.00`;

  it('text that yields no total candidate is ambiguous, not unambiguous', () => {
    const noTotal = `${HDR('ACME')}Widget 115.00\nAmt 115.00\nCARD 115.00`;
    expect(isAmbiguousTotal({ rawText: noTotal, warnings: [] })).toBe(true);
  });

  it('a document with NO text at all is still let through — that is the VLM image', () => {
    expect(isAmbiguousTotal({ rawText: '', warnings: [] })).toBe(false);
    expect(isAmbiguousTotal({ rawText: null, warnings: [] })).toBe(false);
  });

  it('a currency other than the rand refuses on both the AP route and the gate', () => {
    expect(isAmbiguousTotal({ rawText: USD, warnings: [] })).toBe(true);
    expect(refusal(USD, 115, 100, 15)).toBe('the document names a currency other than the rand');
  });

  it('the currency alone refuses: everything else on the document reconciles', () => {
    // Without the currency line this document auto-approves (next test), so
    // nothing but the currency check can be what refuses it.
    const body = 'Widget 100.00\nSub Total 100.00\nVAT 15.00\nTOTAL 115.00\nCARD 115.00';
    expect(isAmbiguousTotal({ rawText: `${HDR('ACME')}Currency: USD\n${body}`, warnings: [] })).toBe(true);
    expect(isAmbiguousTotal({ rawText: `${HDR('ACME')}${body}`, warnings: [] })).toBe(false);
    expect(refusal(`${HDR('ACME')}Currency: USD\n${body}`, 115, 100, 15))
      .toBe('the document names a currency other than the rand');
  });

  it.each(['EUR 115.00', 'GBP 115.00', '$ 115.00', '€115.00'])('%s refuses', (line) => {
    expect(isAmbiguousTotal({ rawText: `${HDR('ACME')}Widget 100.00\nTOTAL 115.00\n${line}`, warnings: [] })).toBe(true);
  });

  it('an ordinary rand document is not caught by the currency check', () => {
    for (const total of ['TOTAL R 115.00', 'TOTAL ZAR 115.00', 'TOTAL R115.00']) {
      const zar = `${HDR('ACME')}Widget 100.00\nSub Total 100.00\nVAT 15.00\n${total}\nCARD 115.00`;
      expect(isAmbiguousTotal({ rawText: zar, warnings: [] })).toBe(false);
    }
  });
});

describe('K-076 r17 LOW-1 — rule 2 forgives only what a BALANCED payment sum explains', () => {
  it('a change line larger than the total with no tender at all is not forgiven', () => {
    const text = `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nChange 300.00`;
    expect(unreconciledFigure(text, 115)).toEqual({ reason: 'larger', value: 300 });
  });

  it('a cash tender and its change, which DO balance, still are', () => {
    const text = `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCASH 300.00\nCHANGE 185.00`;
    expect(unreconciledFigure(text, 115)).toBeNull();
  });
});
