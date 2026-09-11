/**
 * Round 29 (review of `19c4123b3`, 2H/1M/2L).
 *
 * HIGH-1: round 28's 15/115 bound cannot see a pre-tax total when part of the
 * net is not standard-rated (`Consulting 800 / CIPC fee (no VAT) 200 / Total
 * (excl. VAT) 1000.00 / VAT 15% 120.00` posted R1 000 against R1 120). HIGH-2:
 * approval passed a NULL VAT, and the invoice builder then invented 15/115 of
 * the total as input tax. LOW-1: the VAT reader learns leader dots, `=`, `BTW`
 * and `Belasting`. LOW-2: `Copy No: 2 of 2`. The reviewer's inputs.
 */
import { describe, expect, it } from 'vitest';
import { extractAmounts } from '@/modules/accounting/services/core/ocrExtractionService';
import { unreconciledFigure } from '@/modules/accounting/services/core/ocrLargerFigure';
import { identifiesAsPurchase } from '@/modules/accounting/services/core/purchaseTitle';
import { unattendedPostingRefusal, refusesUnattendedApproval } from '@/modules/accounting/services/core/unattendedPostingGate';

const HDR = (vendor: string) => `${vendor}\nTAX INVOICE\nVAT No 4123456789\nDate: 2026-09-01\nInvoice No: 0045\n`;
const BANK = 'Banking details: FNB Acc 62812345678';
type Doc = { rawText: string; subtotal: number | null; vatAmount: number | null; totalAmount: number };
const doc = ({ rawText, subtotal, vatAmount, totalAmount }: Doc) => ({
  documentType: 'invoice' as const, rawText, subtotal, vatAmount, totalAmount, warnings: [], extractionMethod: 'vlm' as const,
});
const routes = (d: Doc) => ({ post: unattendedPostingRefusal(doc(d)) === null, approve: !refusesUnattendedApproval(doc(d)) });

const MIXED = [
  { vendor: 'Mokoena Consulting', items: 'Consulting 8 hrs 800.00\nCIPC filing fee (no VAT) 200.00\n', vat: 120 },
  { vendor: 'Karoo Meat Wholesalers', items: 'Brown bread x40 (Z) 300.00\nBraai packs 700.00\n', vat: 105 },
  { vendor: 'Veg Direct', items: 'Fresh vegetables (Z) 850.00\nPlastic crates 150.00\n', vat: 22.5 },
];
const LABELS = ['Total', 'Total (excl. VAT)', 'Total (Excl)', 'Total (ex VAT)', 'Invoice Total', 'Total: R', 'Total (Excl. VAT) R'];
const TAX = ['VAT 15%', 'VAT', 'VAT @ 15%'];

describe('K-076 r29 HIGH-1 — a pre-tax total the 15/115 bound cannot see', () => {
  it.each(MIXED.flatMap((m) => LABELS.flatMap((l) => TAX.map((t) => [m.vendor, l, t, m] as const))))(
    '%s: "%s 1000.00 / %s" with no grand total refuses on both routes, stored and nulled', (_v, label, tax, m) => {
      const rawText = `${HDR(m.vendor)}${m.items}${label} 1000.00\n${tax} ${m.vat.toFixed(2)}\n${BANK}`;
      for (const subtotal of [1000 - m.vat, null]) {
        expect(routes({ rawText, subtotal, vatAmount: m.vat, totalAmount: 1000 })).toEqual({ post: false, approve: false });
      }
    });

  it('(a) the trailing "excl VAT" label refuses even when something paid the pre-tax figure', () => {
    const m = MIXED[0]!;
    const rawText = `${HDR(m.vendor)}${m.items}Total 1000.00 excl VAT\nVAT 15% 120.00\nEFT 1000.00`;
    expect(routes({ rawText, subtotal: 880, vatAmount: 120, totalAmount: 1000 }).post).toBe(false);
  });

  it('the same documents with their grand total printed, and honest inclusive recaps, still post', () => {
    const m = MIXED[0]!;
    const full = `${HDR(m.vendor)}${m.items}Sub Total 1000.00\nVAT 15% 120.00\nTotal Due 1120.00\n${BANK}`;
    expect(routes({ rawText: full, subtotal: 1000, vatAmount: 120, totalAmount: 1120 })).toEqual({ post: true, approve: true });
    const wimpy = `${HDR('Wimpy')}Burger 89.90\nChips 32.50\nCoke 25.00\nTOTAL 147.40\nVAT 19.23`;
    expect(routes({ rawText: wimpy, subtotal: 128.17, vatAmount: 19.23, totalAmount: 147.4 }).post).toBe(true);
    // Unpaid, VAT below the only total: the arithmetic (130.43 = 1000 × 15/115) proves it inclusive.
    const incl = `${HDR('Joe Plumbing')}Labour 1000.00\nTotal 1000.00\nVAT 130.43`;
    expect(routes({ rawText: incl, subtotal: 869.57, vatAmount: 130.43, totalAmount: 1000 }).post).toBe(true);
    const kwik = 'KWIKSPAR Linden\nTAX INVOICE\nVAT No 4130987654\nBROWN BREAD * 18.99\nMILK 2L * 34.99\n'
      + 'MAIZE MEAL 5KG * 59.99\nEGGS 18 * 54.99\nWASHING POWDER 2KG 89.99\nTOTAL 258.95\nCARD 258.95\n* ZERO RATED\nVAT 15% 11.74';
    expect(routes({ rawText: kwik, subtotal: 247.21, vatAmount: 11.74, totalAmount: 258.95 }).post).toBe(true);
  });
});

describe('K-076 r29 HIGH-1 (b) — the exemptions, each pinned', () => {
  const m = MIXED[0]!;
  it('a tax line below the total that says it is included is a recap, not an addition', () => {
    const base = `${HDR(m.vendor)}${m.items}Total 1000.00\n`;
    expect(unreconciledFigure(`${base}VAT INCL 120.00`, 1000, { subtotal: 880, vatAmount: 120 })).toBeNull();
    expect(unreconciledFigure(`${base}VAT 120.00`, 1000, { subtotal: 880, vatAmount: 120 })).toEqual({ reason: 'pretax', value: 120 });
  });

  it('a VAT recap below a total whose composition is printed above it is a recap', () => {
    const text = `${HDR(m.vendor)}${m.items}Sub Total 1000.00\nVAT 15% 120.00\nTotal Due 1120.00\nTotal VAT 120.00`;
    expect(unreconciledFigure(text, 1120, { subtotal: 1000, vatAmount: 120 })).toBeNull();
  });
});

describe('K-076 r29 HIGH-2 — unattended approval never books an invented VAT', () => {
  it.each([
    'Joe Garden Services\nINVOICE\nInvoice No: 12\nDate: 2026-09-02\nGarden service September 1 1000.00 1000.00\nAmount Due 1000.00',
    `${HDR('Checkers')}Maize Meal 1 1000.00 1000.00\nVAT 0.00\nTotal 1000.00`,
    `${HDR('Waltons')}Copy Paper 1 1000.00 1000.00\nTotal 1000.00`,
  ])('a null VAT refuses approval: %j', (rawText) => {
    expect(refusesUnattendedApproval(doc({ rawText, subtotal: null, vatAmount: null, totalAmount: 1000 }))).toBe(true);
  });

  it('with no text either: the builder would still invent 15/115 of the total', () => {
    expect(refusesUnattendedApproval(doc({ rawText: '', subtotal: null, vatAmount: null, totalAmount: 1000 }))).toBe(true);
    expect(refusesUnattendedApproval(doc({ rawText: '', subtotal: null, vatAmount: 0, totalAmount: 1000 }))).toBe(false);
  });
});

describe('K-076 r29 LOW-1 — the VAT reader learns leader dots, `=`, BTW and Belasting', () => {
  const BODY = 'Labour 1000.00\nSub Total 1000.00\n';
  it.each(['VAT 15%.........150.00', 'VAT........150.00', 'VAT = 150.00', 'V.A.T. @ 15% = 150.00', 'BTW 150.00',
    'BTW @ 15% 150.00', 'Belasting 150.00'])('"%s" reads 150 and the invoice is approved', (line) => {
    const rawText = `${HDR('Joe Plumbing')}${BODY}${line}\nTotal 1150.00`;
    expect(extractAmounts(rawText).vatAmount).toBe(150);
    expect(refusesUnattendedApproval(doc({ rawText, subtotal: 1000, vatAmount: 150, totalAmount: 1150 }))).toBe(false);
  });

  it.each(['Delivery.........150.00', 'Delivery = 150.00', 'BTW No 4123456789', 'BELASTINGFAKTUUR Nr 5521'])(
    'money beside, but not the tax: "%s" is not read as the VAT', (line) => {
      expect(extractAmounts(`${HDR('Joe Plumbing')}${line}\nLabour 1000.00\nTotal 1150.00`).vatAmount).not.toBe(150);
      expect(extractAmounts(`${HDR('Joe Plumbing')}${line}\nLabour 1000.00\nTotal 1150.00`).vatAmount).not.toBe(4123456789);
    });
});

describe('K-076 r29 LOW-2 — `Copy No: 2 of 2`', () => {
  it('refuses', () => {
    const text = 'Makro Woodmead\nTAX INVOICE\nVAT No 4123456789\nInvoice No: 004512\nDate: 2026-09-05\nCOFFEE 1KG 189.99\n'
      + 'Sub Total 165.21\nVAT 24.78\nTOTAL 189.99\nCARD 189.99\nCopy No: 2 of 2';
    expect(identifiesAsPurchase({ rawText: text, documentType: 'invoice' })).toBe(false);
  });
});
