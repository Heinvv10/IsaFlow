/**
 * Round 30 (review of `38a6a6b17`, 1M/3L).
 *
 * MEDIUM: no VAT is invented on a draft (builder pinned here; the DB side and
 * the MCP refusal in `k072-capture-vat-unread.int.test.ts`). LOW-1: rule (b)'s
 * arithmetic exemption posted a pre-tax total whose VAT happened to equal
 * 15/115 of it — void it where a line is zero-rated, exempt or no-VAT, and
 * teach rule (a) the abbreviated and Afrikaans forms. LOW-2: pin the tolerance,
 * `before VAT`, `nett of VAT` and `incl` on the total's line. LOW-3: a `VAT =
 * 15%` legend is not a VAT of 15. The reviewer's inputs.
 */
import { describe, expect, it } from 'vitest';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { buildInvoiceFromExtraction, VAT_UNREAD_NOTE } from '@/modules/accounting/services/core/aiInvoicePipelineService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 0045\n`;
const pretax = { reason: 'pretax' };

describe('K-076 r30 MEDIUM — the builder never invents a VAT', () => {
  const base = { totalAmount: 1000, subtotal: null, vatAmount: null, lineItems: [], referenceNumber: 'X1', date: '2026-09-01' } as unknown as ExtractedDocument;
  it('no VAT read: no VAT, a 0% rate on the invoice and its line, the line at the total, and the note', () => {
    const inv = buildInvoiceFromExtraction(base, 'sup');
    expect(inv).toMatchObject({ taxAmount: 0, taxRate: 0, notes: VAT_UNREAD_NOTE });
    expect(inv.items).toEqual([{ description: 'As per invoice', quantity: 1, unitPrice: 1000, taxRate: 0 }]);
  });

  it('a VAT read — zero included — is kept as read, with no note', () => {
    expect(buildInvoiceFromExtraction({ ...base, vatAmount: 150, subtotal: 1000, totalAmount: 1150 }, 'sup'))
      .toMatchObject({ taxAmount: 150, taxRate: 15, notes: undefined });
    expect(buildInvoiceFromExtraction({ ...base, vatAmount: 0 }, 'sup')).toMatchObject({ taxAmount: 0, taxRate: 15, notes: undefined });
  });
});

describe('K-076 r30 LOW-1 — the arithmetic exemption where a line is not standard-rated', () => {
  const doc = (items: string, total: number, vat: string) => `${HDR('Mokoena Attorneys')}${items}Total ${total.toFixed(2)}\n${vat}\nBanking details: FNB Acc 62812345678`;
  it.each(['Deeds office fee (no VAT)', 'Deeds office fee (non-VAT)', 'Deeds office fee (exempt)', 'Deeds office fee (zero rated)',
    'Deeds office fee 0%', 'Aktefooi (vrygestel)', 'Aktefooi (geen BTW)', 'Deeds office fee (Z)', 'Disbursements'])(
    '"%s 150.30" beside a fee, VAT exactly 15/115 of the total: refuses', (line) => {
      const text = doc(`Conveyancing fee 1000.00\n${line} 150.30\n`, 1150.3, 'VAT 15% 150.04');
      expect(unreconciledFigure(text, 1150.3, { subtotal: 1000.26, vatAmount: 150.04 })).toMatchObject(pretax);
    });

  it('with no such line the arithmetic still proves an honest inclusive total', () => {
    expect(unreconciledFigure(doc('Conveyancing fee 1150.30\n', 1150.3, 'VAT 15% 150.04'), 1150.3, { subtotal: 1000.26, vatAmount: 150.04 })).toBeNull();
  });

  it.each(['Totaal (Eks. BTW)', 'Totaal (Eksklusief BTW)', 'Totaal (sonder BTW)', 'Total (Exc VAT)', 'Total (ex-VAT)',
    'Total (w/o VAT)', 'Total without VAT', 'Total before VAT', 'Total nett of VAT', 'Total (Excl)'])(
    '(a) "%s 1000.00" is a net even when the VAT fits the arithmetic', (label) => {
      const text = `${HDR('Kruger')}Consulting 1000.00\n${label} 1000.00\nVAT 15% 130.43\nEFT 1000.00`;
      expect(unreconciledFigure(text, 1000, { subtotal: 869.57, vatAmount: 130.43 })).toMatchObject(pretax);
    });

  it.each(['Nett', 'Net Amount', 'Netto', 'Subtotal', 'Sub-Total', 'Subtotaal', 'Goods Value', 'Taxable Amount', 'uitgesluit BTW'])(
    '(a) a trailing "%s" after the figure names it a net', (tail) => {
      const text = `${HDR('Kruger')}Consulting 1000.00\nTotal 1000.00 ${tail}\nVAT 15% 130.43\nEFT 1000.00`;
      expect(unreconciledFigure(text, 1000, { subtotal: 869.57, vatAmount: 130.43 })).toMatchObject(pretax);
    });

  it('a payable label BEFORE the figure is not a trailing net', () => {
    const text = `${HDR('Kruger')}Consulting 1000.00\nNett Amount Due 1000.00\nVAT 130.43\nEFT 1000.00`;
    expect(unreconciledFigure(text, 1000, { subtotal: 869.57, vatAmount: 130.43 })).toBeNull();
  });
});

describe('K-076 r30 LOW-2 — the pins', () => {
  const unpaid = (vat: string) => `${HDR('Joe Plumbing')}Labour 1000.00\nTotal 1000.00\nVAT ${vat}`;
  it('the 5-cent window on 1 000: 130.39 is inclusive, 130.38 is not', () => {
    expect(unreconciledFigure(unpaid('130.39'), 1000, { subtotal: 869.61, vatAmount: 130.39 })).toBeNull();
    expect(unreconciledFigure(unpaid('130.38'), 1000, { subtotal: 869.62, vatAmount: 130.38 })).toMatchObject(pretax);
  });

  it('`incl` on the total\'s own line: its VAT recap below is inside it', () => {
    const text = `${HDR('Mokoena')}Consulting 800.00\nFee (no VAT) 200.00\nTotal Incl VAT 1000.00\nVAT 104.35`;
    expect(unreconciledFigure(text, 1000, { subtotal: 895.65, vatAmount: 104.35 })).toBeNull();
  });
});

describe('K-076 r30 LOW-3 — a rate legend is not the VAT', () => {
  it.each(['VAT = 15%', 'VAT=15%', 'VAT = 15.00%', 'BTW = 15%', 'VAT: 15%', 'VAT RATE = 15%'])('"%s" leaves the real VAT line', (legend) => {
    expect(extractAmounts(`SPAR Linden\nTAX INVOICE\nVAT No 4130987654\n${legend}\nParking 20.00\nTotal 20.00\nVAT 2.61\nCard 20.00`).vatAmount).toBe(2.61);
  });
});
