/**
 * Round 22, HIGH-1: a number line is never a title, and a header naming a
 * document that is not a first-time purchase refuses, title or no title.
 *
 * Round 21 let a field line (`Invoice No: 55123`) stand as a purchase title,
 * and nearly every credit note, pro forma and reprint prints one to cite the
 * invoice — `DISCOUNT NOTE / … / Invoice No: 55123 / TOTAL 945.00` posted +945
 * as a purchase. Every input is the round-21 reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { refusesUnattendedApproval, unattendedPostingRefusal } from '@/modules/accounting/services/core/unattendedPostingGate';

const NUMBER_LINES = ['', 'Invoice No: 004512', 'Invoice Number: 98765432', 'Receipt No: 004512',
  'Invoice No: INV-20931', 'Tax Invoice No: 88123', 'Invoice No: 55123', 'Against Invoice No: 55123',
  'Original Invoice: 55123', 'Ref Invoice No: 55123', 'No: 000123'];
const header = (title: string, numberLine: string) =>
  `GAME Stores\n${title}\nVAT No 4123456789\nDate: 2026-09-01\n${numberLine ? `${numberLine}\n` : ''}`;
const BODY = 'Kettle 499.00\nSub Total 433.91\nVAT 15% 65.09\nTOTAL 499.00\nCARD 499.00';
const doc = (text: string) => ({
  documentType: 'invoice' as const, rawText: text, subtotal: 433.91, vatAmount: 65.09, totalAmount: 499,
  warnings: [], extractionMethod: 'vlm' as const, vendorName: 'GAME Stores', vendorAddress: '1 Main Rd, Sandton',
});

const NOT_PURCHASES = ['COPY TAX INVOICE', 'TAX INVOICE (COPY)', 'TAX INVOICE COPY', 'TAX INVOICE (REPRINT)',
  'REPRINT', 'DUPLICATE TAX INVOICE', 'DUPLICATE', 'PRO FORMA INVOICE', 'PROFORMA INVOICE', 'QUOTATION',
  'ESTIMATE', 'DELIVERY NOTE', 'ORDER CONFIRMATION', 'STATEMENT', 'GOODS RECEIVED VOUCHER', 'ACME TRADING'];
const CREDIT_TITLES = ['DISCOUNT NOTE', 'SETTLEMENT DISCOUNT', 'SHORT DELIVERY', 'SHORTAGE CLAIM',
  'DAMAGES CLAIM', 'CLAIM', 'ADJUSTMENT', 'ALLOWANCE', 'INCENTIVE NOTE', 'BONUS NOTE', 'PROMOTION CLAIM',
  'SWOP SLIP', 'SWAP SLIP', 'EXCH SLIP', 'GOODS ACCEPTED BACK', 'REBATE NOTE', 'VOLUME REBATE', 'RMA',
  'NOTA DE ABONO', 'ABONO', 'REMBOURSEMENT', 'RÜCKERSTATTUNG', 'RIMBORSO', 'ANULACIÓN', 'ONTVANGSBEWYS TERUG'];

describe('K-076 r22 HIGH-1 — a number line is never a title', () => {
  it.each(['Invoice No: 55123', 'Invoice Number: 98765432', 'Receipt No: 004512', 'Tax Invoice No: 88123',
    'TAX INVOICE No 88123', 'TAX INVOICE #12345', 'TAX INVOICE: 12345', 'BELASTINGFAKTUUR Nr 5521'])(
    '"%s" is a field, not a title', (line) => {
      expect(identifiesAsPurchase(doc(`GAME Stores\n${line}\n${BODY}`))).toBe(false);
    });

  it.each(NOT_PURCHASES.flatMap((t) => NUMBER_LINES.map((n) => [t, n])))(
    '"%s" with "%s" is not a purchase, on either route', (title, numberLine) => {
      const d = doc(`${header(title, numberLine)}${BODY}`);
      expect(identifiesAsPurchase(d)).toBe(false);
      expect(unattendedPostingRefusal(d)).not.toBeNull();
      expect(refusesUnattendedApproval(d)).toBe(true);
    });

  it.each(CREDIT_TITLES.flatMap((t) => NUMBER_LINES.map((n) => [t, n])))(
    'the credit title "%s" with "%s" refuses on either route', (title, numberLine) => {
      const d = doc(`${header(title, numberLine)}${BODY}`);
      expect(unattendedPostingRefusal(d)).not.toBeNull();
      expect(refusesUnattendedApproval(d)).toBe(true);
    });

  it('the reviewer\'s F15: a Makro reprint citing its invoice number refuses', () => {
    const text = 'Makro Woodmead\nTAX INVOICE (REPRINT)\nVAT No 4123456789\nDate: 2026-09-05\nInvoice No: 004512\n'
      + 'Kettle 1 189.99 189.99\nSub Total 165.21\nVAT 15% 24.78\nTOTAL 189.99\nCARD 189.99';
    expect(identifiesAsPurchase({ rawText: text, documentType: 'invoice' })).toBe(false);
  });
});

describe('K-076 r22 HIGH-1 — a disqualifying word refuses beside a real title', () => {
  it.each(['TAX INVOICE\nCOPY', 'TAX INVOICE\n*** REPRINT ***', 'TAX INVOICE / STATEMENT', 'TAX INVOICE\nSETTLEMENT DISCOUNT',
    'TAX INVOICE\nDELIVERY NOTE', 'TAX INVOICE\nGRV No: 0012345', 'TAX INVOICE\nSHORT DELIVERY',
    'TAX INVOICE\nPRO-FORMA', 'TAX INVOICE\nCUSTOMER CLAIM', 'TAX INVOICE\nDISCOUNT SLIP'])(
    '"%s" refuses', (lines) => {
      expect(identifiesAsPurchase(doc(`GAME Stores\n${lines}\n${BODY}`))).toBe(false);
    });

  it('the supplier\'s own name is not the document\'s; a column heading is not a discount note', () => {
    const copyShop = { ...doc(`Copy Shop Rosebank\nTAX INVOICE\n${BODY}`), vendorName: 'Copy Shop Rosebank' };
    expect(identifiesAsPurchase(copyShop)).toBe(true);
    // The same name with no extracted vendor to scrub is a COPY in the header.
    expect(identifiesAsPurchase({ ...copyShop, vendorName: null })).toBe(false);
    expect(identifiesAsPurchase(doc(`GAME Stores\nTAX INVOICE\nDescription Qty Price Discount Nett\n${BODY}`))).toBe(true);
  });

  it.each(['TAX INVOICE', 'TAX INVOICE BELASTINGFAKTUUR', 'TAX INVOICE / BELASTINGFAKTUUR', 'INVOICE',
    'TILL SLIP', 'CASH SALE'])('"%s" alone on its line, with a number field under it, is a purchase', (title) => {
    for (const numberLine of ['Invoice No: 55123', 'Receipt No: 004512', '']) {
      expect(identifiesAsPurchase(doc(`${header(title, numberLine)}${BODY}`))).toBe(true);
    }
  });
});
