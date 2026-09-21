/**
 * Round 23 (review of `440adf223`, 1H/1M/2L, all pre-existing).
 *
 * HIGH-1: item rows that sum to MORE than both the net and the total carry a
 * charge neither covers, and posted the lower total. MEDIUM-1: a reprint
 * marked below the header, or in Afrikaans, posted a second time. LOW-1: a
 * six-digit branch code is a reference. LOW-2: a header FIELD citing another
 * document is not that document. Every input is the round-22 reviewer's.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { unattendedPostingRefusal, refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const LABOUR = `${HDR('Joe Plumbing CC')}Labour 1000.00\n`;
const PBLOCK = 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n';
const PK = { subtotal: 1000, vatAmount: 150 };
const gateDoc = (text: string, total: number, subtotal: number, vat: number) => ({
  documentType: 'invoice' as const, rawText: text, subtotal, vatAmount: vat, totalAmount: total,
  warnings: [], extractionMethod: 'vlm' as const,
});

describe('K-076 r23 HIGH-1 — item rows that exceed both the net and the total', () => {
  it.each(['Delivery 350.00', 'Delivery R350', 'Delivery R 350.00', 'Call-out 350.00', 'Parts 1 350.00 350.00',
    'Delivery within 5 days R350', 'Hire 1 day 450'])('"%s" beside the labour refuses, on both routes', (row) => {
    const text = `${LABOUR}${row}\n${PBLOCK}`;
    expect(unreconciledFigure(text, 1150, PK)).toEqual({ reason: 'stray', value: row.includes('450') ? 1450 : 1350 });
    const doc = gateDoc(text, 1150, 1000, 150);
    expect(unattendedPostingRefusal(doc)).not.toBeNull();
    expect(refusesUnattendedApproval(doc)).toBe(true);
  });

  it('rows that sum UNDER the net leave the printed total the payable', () => {
    // A fuel slip's litres, a line the reader dropped: the printed total stands.
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}`.replace('Labour 1000.00', 'Labour 900.00'), 1150, PK)).toBeNull();
    expect(unreconciledFigure(`${HDR('Engen')}ULP 95 40.00L\nFuel 1000.00\n${PBLOCK}CARD 1150.00`, 1150, PK)).toBeNull();
  });

  it('a named prior balance and a payment row are not items; a bare "Balance" is', () => {
    for (const row of ['Balance brought forward 500.00', 'Balance b/f 500.00', 'Previous balance 500.00', 'Opening balance 500.00']) {
      expect(unreconciledFigure(`${LABOUR}${row}\n${PBLOCK}`, 1150, PK)).toBeNull();
    }
    expect(unreconciledFigure(`${LABOUR}EFT 1150.00\n${PBLOCK}`, 1150, PK)).toBeNull();
    expect(unreconciledFigure(`${LABOUR}Balance 500.00\n${PBLOCK}`, 1150, PK)).toEqual({ reason: 'stray', value: 1500 });
  });
});

describe('K-076 r23 MEDIUM-1 — a reprint marker on ANY line refuses', () => {
  const makro = (title: string, footer = '') => `Makro Woodmead\n${title}\nVAT No 4123456789\nInvoice No: 004512\n`
    + `Date: 2026-09-05\nCOFFEE 1KG 189.99\nSub Total 165.21\nVAT 24.78\nTOTAL 189.99\nCARD 189.99${footer ? `\n${footer}` : ''}`;
  const purchase = (text: string) => identifiesAsPurchase({ rawText: text, documentType: 'receipt' });

  it.each(['** REPRINT **', 'DUPLICATE RECEIPT', '*** COPY ***', 'REPRINTED 2026-09-06', 'This is a copy of the original',
    'KOPIE', 'HERDRUK', 'RE-ISSUED', 'TRAINING MODE'])('footer "%s" refuses', (footer) => {
    expect(purchase(makro('TAX INVOICE', footer))).toBe(false);
  });

  it.each(['KOPIE', 'AFSKRIF', 'HERDRUK', 'DUPLIKAAT', 'RE PRINT', 'C O P Y', 'RE-ISSUED', 'TRAINING MODE', 'LAY-BY',
    'LAYBY DEPOSIT', 'SALES ORDER', 'JOB CARD', 'REMITTANCE ADVICE'])('"%s" under a pure TAX INVOICE title refuses', (word) => {
    // On its own line, so the title rule cannot be what refuses it.
    expect(purchase(makro(`TAX INVOICE\n${word}`))).toBe(false);
    expect(purchase(makro('TAX INVOICE'))).toBe(true);
  });

  it('a card slip\'s CUSTOMER/MERCHANT COPY is an original print, not a reprint; Copy Paper is an item', () => {
    for (const footer of ['CUSTOMER COPY', 'MERCHANT COPY', '*** CARDHOLDER COPY ***', 'KLANT KOPIE']) {
      expect(purchase(makro('TAX INVOICE', footer))).toBe(true);
    }
    expect(purchase(makro('TAX INVOICE').replace('COFFEE 1KG', 'Copy Paper A4'))).toBe(true);
  });
});

describe('K-076 r23 LOW-1 — a six-digit branch code is a reference', () => {
  it.each(['Bank: FNB Acc 62012345678 Branch 250655', 'Branch: 250655', 'Branch Code: 250655', 'Br Code 632005',
    'Branch Code: 250 655', 'Nedbank Acc 1234567890 Branch No 198765'])('"%s" on an unpaid invoice is not money', (line) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).toBeNull();
  });

  it.each(['Branch 25065', 'Branch 350', 'Branch 1234567 Deposit 350'])('"%s" is still money', (line) => {
    expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).not.toBeNull();
  });
});

describe('K-076 r23 LOW-2 — a field citing another document is not that document', () => {
  const invoice = (line: string) => identifiesAsPurchase({
    rawText: `Smith Steel\nTAX INVOICE\n${line}\nVAT No 4123456789\nSteel 2000.00\nSub Total 2000.00\nVAT 300.00\nTOTAL 2300.00`,
    documentType: 'invoice',
  });

  it.each(['Delivery Note No: DN4411', 'Delivery Note No DN4411', 'Purchase Order No: PO4411',
    'Your Order No: 4411', 'Quote No: Q2231', 'Customer Copy', 'Note: goods remain our property until paid',
    'Settlement: 2.5% within 7 days', 'Statement date: 2026-09-30', 'Sales Order No: SO1182', 'Job Card No: 5521'])(
    '"%s" in the header still posts', (line) => {
      expect(invoice(line)).toBe(true);
    });

  it.each(['DELIVERY NOTE', 'PURCHASE ORDER', 'QUOTATION', 'STATEMENT', 'SETTLEMENT DISCOUNT', 'GRV No: 0012345',
    'GRN: 5521', 'ORDER CONFIRMATION No: 55'])('"%s" still refuses', (line) => {
    expect(invoice(line)).toBe(false);
  });
});
