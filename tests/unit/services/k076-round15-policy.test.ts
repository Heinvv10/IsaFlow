/**
 * Round 15: the two VOCABULARIES the round-14 review beat, replaced by rules.
 *
 * HIGH-1 was a charge printed after the total under a name `ADDITION_LABEL`
 * did not know (`SERVICE 10%`, `Waiter`, `Freight`, `Shipping`, `Handling`),
 * settled by a SPLIT tender so no single figure exceeded the total. It is now
 * decided by arithmetic: what the document was paid must equal the total it
 * prints. HIGH-2/MEDIUM-1/MEDIUM-2 were credit and refund words the anchored
 * header missed — a document number beside the word, an Afrikaans spelling,
 * a void, a reversal, a scanner's `CRED1T`. A credit word anywhere now
 * refuses, and the carve-back is a list of benign PHRASES.
 *
 * Every input below is one the round-14 reviewer measured on `cd1d2b452`,
 * including the two over-refusals (LOW-1 and the `RETURNS` policy footer).
 *
 * Round 16 replaced `unsettledTender` — which read only the text BELOW the
 * total — with `unreconciledFigure`, which reads the whole document. These
 * cases are unchanged by that; they are re-expressed against the new call and
 * still assert the same amounts. `paid` is the payment-sum arm, `stray` the
 * unexplained-figure arm.
 */
import { describe, expect, it } from 'vitest';
import { hasCreditIndicator } from '@/modules/accounting/services/core/creditIndicators';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { unattendedPostingRefusal } from '@/modules/accounting/services/core/unattendedPostingGate';

const OCEAN = 'Ocean Basket Sandton\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 88123\n'
  + 'Hake and Chips 1 200.00 200.00\n';
const BLOCK = 'Sub Total 200.00\nVAT 15% 30.00\nTotal 230.00\n';
const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nReceipt No: 004512\n`;

/** The gate's own answer for a VLM-read document, which is the path in play. */
const refusal = (text: string, total: number, subtotal: number, vat: number) => unattendedPostingRefusal({
  documentType: 'receipt', rawText: text, subtotal, vatAmount: vat, totalAmount: total,
  warnings: [], extractionMethod: 'vlm',
});

const CHARGE_NAMES = ['SERVICE 10%', 'SERVICE', 'Waiter', 'Freight', 'Shipping', 'Handling', 'Courier', 'Surcharge', 'Levy'];

describe('K-076 r15 — a charge after the total, found by arithmetic not by name', () => {
  it.each(CHARGE_NAMES)('%s with a split card tender asks for 253.00, not 230.00', (name) => {
    const text = `${OCEAN}${BLOCK}${name} 23.00\nVISA 126.50\nMASTERCARD 126.50`;
    expect(unreconciledFigure(text, 230)?.value).toBe(253);
    expect(refusal(text, 230, 200, 30)).toBe('the document was paid 253.00, not the total read');
  });

  it.each(CHARGE_NAMES)('%s with a split EFT tender is the same document', (name) => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}${name} 23.00\nEFT 126.50\nEFT 126.50`, 230)?.value).toBe(253);
  });

  it.each(CHARGE_NAMES)('%s with the tip settled in cash beside a card equal to the total', (name) => {
    const text = `${OCEAN}${BLOCK}CARD 230.00\n${name} 23.00 CASH`;
    expect(unreconciledFigure(text, 230)?.value).toBe(253);
  });

  it.each(CHARGE_NAMES)('%s printed with NO tender at all is still unexplained', (name) => {
    const text = `${OCEAN}${BLOCK}${name} 23.00`;
    expect(unreconciledFigure(text, 230)?.value).toBe(23);
    expect(refusal(text, 230, 200, 30)).toBe('the document prints 23.00 below its total, which nothing explains');
  });

  it('an ordinary purchase settles exactly and is not refused for its tender', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.00`, 230)).toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}VISA 115.00\nMASTERCARD 115.00`, 230)).toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CASH 300.00\nCHANGE 70.00`, 230)).toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 130.00\nCASH 150.00\nCHANGE 50.00`, 230)).toBeNull();
    expect(refusal(`${OCEAN}${BLOCK}CARD 230.00`, 230, 200, 30)).toBeNull();
  });

  it('only CASH gives change: a card and a "change" line is a mislabelled tip', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 253.00\nChange 23.00`, 230)?.value).toBe(253);
  });

  it('a supplier invoice printing no payment at all is not refused', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}Banking: FNB Acc 62012345678`, 230)).toBeNull();
    // Round 22: a bare number beside a count noun is money on an unpaid
    // document, and a branch code is one (the cost is stated in fix.md).
    expect(unreconciledFigure(`${OCEAN}${BLOCK}Banking: FNB Acc 62012345678 Branch 250655`, 230)).not.toBeNull();
  });

  it('a cent of rounding is allowed, ten cents is not', () => {
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.01`, 230)).toBeNull();
    expect(unreconciledFigure(`${OCEAN}${BLOCK}CARD 230.10`, 230)?.value).toBe(230.1);
  });
});

describe('K-076 r15 — a credit word anywhere refuses', () => {
  it.each([
    ['a refund slip numbered on the header line', `${HDR('GAME')}REFUND SLIP 0012\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00`],
    ['an Afrikaans credit note numbered on the header line', `${HDR('ACME')}KREDIETNOTA Nr KN00123\nWidget 100.00\nBTW 15.00\nTotaal 115.00`],
    ['the Afrikaans verb with two As', `${HDR('GAME')}Ketel 499.00\nBTW 65.09\nTOTAAL 499.00\nTerugbetaal na kaart 499.00`],
    ['VOID', `${HDR('GAME')}VOID\nKettle 499.00\nVAT 65.09\nTOTAL 499.00\nCARD 499.00`],
    ['REVERSAL', `${HDR('GAME')}REVERSAL\nKettle 499.00\nVAT 65.09\nTOTAL 499.00\nCARD 499.00`],
    ['CANCELLED SALE', `${HDR('GAME')}CANCELLED SALE\nKettle 499.00\nVAT 65.09\nTOTAL 499.00\nCARD 499.00`],
    ['GOODS RETURNED', `${HDR('GAME')}GOODS RETURNED\nKettle 499.00\nVAT 65.09\nTOTAL 499.00\nCARD 499.00`],
    ['a scanner reading CREDIT as CRED1T', `${HDR('ACME')}CRED1T NOTE\nWidget 100.00\nVAT 15.00\nTOTAL 115.00`],
    ['a scanner reading NOTE as N0TE', `${HDR('ACME')}CREDIT N0TE\nWidget 100.00\nVAT 15.00\nTOTAL 115.00`],
    ['a scanner reading CREDIT as CREDlT', `${HDR('ACME')}CREDlT NOTE\nWidget 100.00\nVAT 15.00\nTOTAL 115.00`],
    ['REVER5AL', `${HDR('GAME')}REVER5AL\nKettle 499.00\nVAT 65.09\nTOTAL 499.00`],
    ['an exchange slip', `${HDR('GAME')}EXCHANGE SLIP\nKettle 499.00\nVAT 65.09\nTOTAL 499.00`],
    ['a cancellation', `${HDR('GAME')}CANCELLATION\nKettle 499.00\nVAT 65.09\nTOTAL 499.00`],
  ])('%s', (_name, text) => {
    expect(hasCreditIndicator(text, 499)).toBe(true);
  });

  it('the gate refuses the refund slip rather than posting +499.00', () => {
    const text = `${HDR('GAME')}REFUND SLIP 0012\nKettle 499.00\nVAT 15% 65.09\nTOTAL 499.00`;
    expect(refusal(text, 499, 433.91, 65.09)).toBe('the document is a credit note, refund or return');
  });
});

describe('K-076 r15 — the benign phrases carved back out', () => {
  it.each([
    ['a credit card surcharge', `${HDR('SPAR')}Milk 100.00\nCredit card surcharge 5.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nCARD 115.00`],
    ['a VISA CREDIT tender', `${HDR('SPAR')}Milk 100.00\nSub Total 100.00\nVAT 15% 15.00\nTOTAL 115.00\nVISA CREDIT 115.00`],
    ['a no-refund footer', `${HDR('SPAR')}Milk 100.00\nTOTAL 115.00\nCARD 115.00\nNO REFUND WITHOUT SLIP`],
    ['a refund-policy footer', `${HDR('SPAR')}Milk 100.00\nTOTAL 115.00\nCARD 115.00\nRefunds within 30 days with this slip 115.00`],
    ['a RETURNS heading above the policy', `${HDR('SPAR')}Milk 100.00\nTOTAL 115.00\nCARD 115.00\nRETURNS\nGoods may be returned in 7 days`],
    ['a credit note applied to a purchase', `${HDR('ACME')}Widget 100.00\nTOTAL 115.00\nLess credit note CN001 applied 0.00\nCARD 115.00`],
    ['a trade account credit limit', `${HDR('BUILDERS')}Cement 100.00\nTOTAL 115.00\nON CREDIT 115.00\nCredit Limit 5 000.00`],
    ['a card slip naming the account type', `${HDR('GAME')}Kettle 299.00\nTotal 299.00\nCARD 299.00\nAcc Type: CREDIT`],
  ])('%s is an ordinary purchase', (_name, text) => {
    expect(hasCreditIndicator(text, 115)).toBe(false);
  });

  it('a policy footer does not excuse a document that IS a refund', () => {
    const text = `${HDR('GAME')}REFUND SLIP 0012\nKettle 499.00\nTOTAL 499.00\nNO REFUND WITHOUT SLIP`;
    expect(hasCreditIndicator(text, 499)).toBe(true);
  });
});
