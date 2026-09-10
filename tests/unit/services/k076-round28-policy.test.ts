/**
 * Round 28 (review of `edbcffb46`, 1H/3L, plus the lead's VAT-evidence decision).
 *
 * HIGH-1: `Total (excl. VAT) 1000.00 / VAT 15% 150.00` with no grand total
 * posted R1 000 against R1 150. A VAT of 150 is 15% OF 1 000; an inclusive
 * total of 1 000 carries at most 130.43. So the VAT read must fit inside the
 * total read, on both routes. DECISION: unattended APPROVAL needs the VAT to be
 * printed as the tax. LOWs: print dates, `Copy [2/2]`, a charge equal to the
 * net or the total below it, and `SET`/`LIQ` read as currencies.
 */
import { describe, expect, it } from 'vitest';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { namesForeignCurrency } from '@/modules/accounting/services/core/documentCurrency';
import { unattendedPostingRefusal, refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 004512\n`;
const LABOUR = `${HDR('Joe Plumbing CC')}Labour 1000.00\n`;
const doc = (text: string, subtotal: number | null, vat: number, total: number) => ({
  documentType: 'invoice' as const, rawText: text, subtotal, vatAmount: vat, totalAmount: total,
  warnings: [], extractionMethod: 'vlm' as const,
});
const routes = (d: ReturnType<typeof doc>) => ({ post: unattendedPostingRefusal(d) === null, approve: !refusesUnattendedApproval(d) });

describe('K-076 r28 HIGH-1 — the VAT read must fit inside the total read', () => {
  const TOTALS = ['Total 1000.00', 'Total (excl. VAT) 1000.00', 'Total (Excl) 1000.00', 'Total (ex VAT) 1000.00',
    'Invoice Total 1000.00', 'Total: R1000.00', 'Total (Excl. VAT) R1000.00', 'Total 1000.00 excl VAT'];
  const TAX = ['VAT 15% 150.00', 'VAT 150.00', 'VAT @ 15% 150.00', 'Tax 15% 150.00', 'Output VAT 150.00'];
  it.each(TOTALS.flatMap((t) => TAX.map((v) => [t, v])))('"%s / %s" with no grand total refuses on both routes', (t, v) => {
    const text = `${LABOUR}${t}\n${v}\nBanking details: FNB Acc 62812345678`;
    for (const sub of [850, null]) expect(routes(doc(text, sub, 150, 1000))).toEqual({ post: false, approve: false });
  });

  it('pure arithmetic: it holds with no text at all, on the approval route', () => {
    expect(refusesUnattendedApproval({ ...doc('', null, 150, 1000), documentType: 'invoice' })).toBe(true);
    expect(refusesUnattendedApproval({ ...doc('', null, 130.43, 1000), documentType: 'invoice' })).toBe(false);
  });

  it('an honest inclusive total posts, and the tolerance is 5 cents', () => {
    for (const v of ['VAT 130.43', 'VAT @ 15% 130.43']) {
      expect(routes(doc(`${LABOUR}Total 1000.00\n${v}`, 869.57, 130.43, 1000))).toEqual({ post: true, approve: true });
    }
    expect(unattendedPostingRefusal(doc('', 869.52, 130.48, 1000))).not.toMatch(/more than a VAT-inclusive total/);
    expect(unattendedPostingRefusal(doc('', 869.51, 130.49, 1000))).toMatch(/more than a VAT-inclusive total/);
    const slip = `SPAR\nTAX INVOICE\nVAT No 4123456789\nBread 115.00\nTOTAL 115.00\nCARD 115.00\nVAT 15% 15.00`;
    expect(routes(doc(slip, 100, 15, 115)).post).toBe(true);
  });
});

describe('K-076 r28 DECISION — unattended approval needs the VAT printed as the tax', () => {
  it('a VAT the model derived, where the document prints none, is not approved', () => {
    for (const label of ['Total Delivery', 'Total Freight']) {
      const text = `${LABOUR}Sub Total 1000.00\n${label} 150.00\nTOTAL 1150.00`;
      expect(refusesUnattendedApproval(doc(text, 1000, 150, 1150))).toBe(true);
    }
  });

  it('a printed VAT line, a zero VAT, and a document with no text are not judged by it', () => {
    expect(refusesUnattendedApproval(doc(`${LABOUR}Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00`, 1000, 150, 1150))).toBe(false);
    expect(refusesUnattendedApproval(doc(`${HDR('Checkers')}Maize Meal 100.00\nVAT 0.00\nTotal 100.00`, 100, 0, 100))).toBe(false);
    expect(refusesUnattendedApproval(doc('', 1000, 150, 1150))).toBe(false);
  });
});

describe('K-076 r28 LOWs — reprint shapes', () => {
  const makro = (footer: string) => `Makro Woodmead\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 004512\n`
    + `Date: 2026-09-05\nCOFFEE 1KG 189.99\nSub Total 165.21\nVAT 24.78\nTOTAL 189.99\nCARD 189.99\n${footer}`;
  const purchase = (footer: string) => identifiesAsPurchase({ rawText: makro(footer), documentType: 'invoice' });

  it.each(['Print: 05/09/2026 14:32', 'Print 05/09/26', 'Print 05-09-2026', 'Printed: 2026/09/05'])('a print DATE "%s" is not a copy count', (f) => {
    expect(purchase(f)).toBe(true);
  });

  it.each(['Copy [2/2]', 'Copy 2-2', 'Copy 2 of 2 14:32', 'Print 2 of 2'])('"%s" refuses', (f) => {
    expect(purchase(f)).toBe(false);
  });
});

describe('K-076 r28 LOW — below the total, a figure equal to the net or the total is explained only by its role', () => {
  const PBLOCK = 'Sub Total 1000.00\nVAT 15% 150.00\nTOTAL 1150.00\n';
  const PK = { subtotal: 1000, vatAmount: 150 };

  it.each(['Total Freight 1000.00', 'Total Freight 1150.00', 'Total Callout 1150.00', 'Sub Total Delivery 1000.00'])(
    '"%s" under the total refuses', (line) => {
      expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).not.toBeNull();
    });

  // A reprint of the TOTAL is itself the last print of the total, so the net
  // lines are what exercise the qualifiers a summary-only label may carry.
  it.each(['Total Due 1150.00', 'Total Incl VAT 1150.00', 'Sub Total 1000.00', 'Sub Total Excl VAT 1000.00',
    'Nett Amount (Excl) 1000.00'])(
    'a reprinted summary "%s" under the total posts', (line) => {
      expect(unreconciledFigure(`${LABOUR}${PBLOCK}${line}`, 1150, PK)).toBeNull();
    });
});

describe('K-076 r28 — item words are not currencies', () => {
  it.each(['DRILL BIT SET 449.00', 'DISHWASHING LIQ 34.99'])('"%s" is not foreign', (line) => {
    expect(namesForeignCurrency(`${HDR('Builders')}${line}\nTOTAL 449.00`)).toBe(false);
  });
});
