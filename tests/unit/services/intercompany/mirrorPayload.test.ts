/**
 * Intercompany P2: the pure rules of a mirror message's payload. The DATABASE builds a snapshot of the sender's invoice or credit note
 * (cents-exact, so the receiver's draft carries the same number, VAT and total; the reference builder here is what the SQL builder is
 * compared with in mirror-build.int.test.ts); the receiver treats whatever it reads as
 * untrusted input and refuses a payload that does not add up, names a path outside the sender's storage prefix, or is not ZAR.
 */
import { describe, expect, it } from 'vitest';
import { parseMirrorPayload, payloadBlocker } from '@/modules/accounting/services/intercompany/mirrorPayload';
import { allocateLineVat, buildCreditNotePayload, buildInvoicePayload, type InvoiceSource } from '../../../helpers/mirrorReference';

const SENDER = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';

const invoice = (over: Partial<InvoiceSource> = {}): InvoiceSource => ({
  number: 'INV-100', date: '2026-11-18', dueDate: '2026-12-18', currency: 'ZAR',
  subtotal: 1000, taxAmount: 150, total: 1150, notes: null,
  sender: { name: 'Blitz Fibre', vatNumber: '4123456789' },
  lines: [
    { description: 'Fibre install', quantity: 2, unitPrice: 300, amount: 600, taxRate: 15 },
    { description: 'Router', quantity: 1, unitPrice: 400, amount: 400, taxRate: 15 },
  ],
  pdf: { path: `${SENDER}/${DOC}.pdf`, sha256: 'a'.repeat(64) },
  ...over,
});

describe('buildInvoicePayload', () => {
  it('carries the invoice cents-exact: number, dates, totals, lines with their VAT, the sender and the PDF', () => {
    const p = buildInvoicePayload(invoice());
    expect(p).toMatchObject({
      version: 1, kind: 'invoice', number: 'INV-100', date: '2026-11-18', dueDate: '2026-12-18', currency: 'ZAR',
      subtotal: 1000, taxAmount: 150, total: 1150, senderName: 'Blitz Fibre', senderVatNumber: '4123456789',
    });
    expect(p.lines).toEqual([
      { description: 'Fibre install', quantity: 2, unitPrice: 300, taxRate: 15, taxAmount: 90, lineTotal: 600 },
      { description: 'Router', quantity: 1, unitPrice: 400, taxRate: 15, taxAmount: 60, lineTotal: 400 },
    ]);
    expect(p.pdf).toEqual({ path: `${SENDER}/${DOC}.pdf`, sha256: 'a'.repeat(64) });
  });

  it('allocates the header VAT over the lines like a ledger: sum equals the header, each line within a cent of its own rate', () => {
    // header VAT = ROUND(subtotal x 15%): 15.0015 -> 15.00, while the lines' own VAT rounds to 4.99 + 10.00
    const p = buildInvoicePayload(invoice({
      subtotal: 100.01, taxAmount: 15, total: 115.01,
      lines: [
        { description: 'A', quantity: 1, unitPrice: 33.33, amount: 33.33, taxRate: 15 },
        { description: 'B', quantity: 1, unitPrice: 66.68, amount: 66.68, taxRate: 15 },
      ],
    }));
    expect(Math.round(p.lines.reduce((s, l) => s + l.taxAmount, 0) * 100)).toBe(1500);
    expect(parseMirrorPayload(p, 'invoice', SENDER)).toMatchObject({ ok: true });
  });

  it('a header VAT that is not the invoice rate on the subtotal (a forged or legacy header) cannot be carried: the parser refuses the line', () => {
    const p = buildInvoicePayload(invoice({
      subtotal: 100, taxAmount: 40, total: 140,
      lines: [{ description: 'A', quantity: 1, unitPrice: 100, amount: 100, taxRate: 15 }],
    }));
    expect(parseMirrorPayload(p, 'invoice', SENDER)).toMatchObject({ ok: false, error: expect.stringMatching(/VAT is not its amount at its rate/) });
  });

  it('a line whose amount is not quantity x price (rounded) becomes one unit at the line amount', () => {
    const p = buildInvoicePayload(invoice({
      subtotal: 10, taxAmount: 1.5, total: 11.5,
      lines: [{ description: 'Odd', quantity: 3, unitPrice: 3.33, amount: 10, taxRate: 15 }],
    }));
    expect(p.lines[0]).toMatchObject({ quantity: 1, unitPrice: 10, lineTotal: 10, taxAmount: 1.5 });
  });

  it('a missing PDF is carried as null', () => {
    expect(buildInvoicePayload(invoice({ pdf: null })).pdf).toBeNull();
  });
});

describe('allocateLineVat (the ledger way)', () => {
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  it('every invoice whose header VAT is ROUND(sum x rate) allocates to the header exactly, each line within one cent of its own VAT', () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let t = 0; t < 400; t++) {
      const n = 1 + rnd(40);
      const rate = [0, 15, 14, 7.5][rnd(4)]!;
      const amounts = Array.from({ length: n }, () => 1 + rnd(250000));
      const header = Math.round(total(amounts) * rate / 100);
      const vat = allocateLineVat(amounts, amounts.map(() => rate), header);
      expect(total(vat)).toBe(header);
      vat.forEach((c, i) => expect(Math.abs(c - amounts[i]! * rate / 100)).toBeLessThan(1));
    }
  });
  it('a header lower than the lines\' own VAT takes cents off, whatever the gap', () => {
    const low = allocateLineVat([1000, 1000, 1000], [15, 15, 15], 400);
    expect(total(low)).toBe(400);
    expect(Math.max(...low) - Math.min(...low)).toBeLessThanOrEqual(1);
    expect(total(allocateLineVat([1000, 1000, 1000], [15, 15, 15], 100))).toBe(100);
    expect(allocateLineVat([], [], 5)).toEqual([]);
  });
});

describe('what the sender builds is what the receiver can read', () => {
  it('long text is cut at the parser\'s limits, empty text is made readable, and the result parses', () => {
    const p = buildInvoicePayload(invoice({
      notes: 'n'.repeat(5000), sender: { name: 'S'.repeat(500), vatNumber: '   ' },
      lines: [{ description: '   ', quantity: 1, unitPrice: 1000, amount: 1000, taxRate: 15 }, { description: 'd'.repeat(3000), quantity: 1, unitPrice: 0, amount: 0, taxRate: 15 }],
    }));
    expect(p.notes).toHaveLength(2000);
    expect(p.senderName).toHaveLength(200);
    expect(p.senderVatNumber).toBeNull();
    expect(p.lines[0]!.description).toBe('(no description)');
    expect(p.lines[1]!.description).toHaveLength(1000);
    expect(parseMirrorPayload(p, 'invoice', SENDER)).toMatchObject({ ok: true });
  });

  it('a credit note\'s reason is cut the same way', () => {
    const p = buildCreditNotePayload({ number: 'CN-1', date: '2026-11-19', currency: 'ZAR', subtotal: 100, taxAmount: 15, total: 115, taxRate: 15,
      reason: 'r'.repeat(4000), creditsInvoiceNumber: null, sender: { name: 'S', vatNumber: null } });
    expect(p.notes).toHaveLength(2000);
    expect(p.lines[0]!.description).toHaveLength(1000);
    expect(parseMirrorPayload(p, 'credit_note', SENDER)).toMatchObject({ ok: true });
  });

  it('IsaFlow prices a line as quantity x price less a PERCENT discount and refuses a negative quantity, price or discount (priceDraftLines): a discounted line is sent as one unit and parses', () => {
    const p = buildInvoicePayload(invoice({
      subtotal: 90, taxAmount: 13.5, total: 103.5,
      lines: [{ description: '10% off', quantity: 3, unitPrice: 33.33, amount: 90, taxRate: 15 }],
    }));
    expect(p.lines[0]).toMatchObject({ quantity: 1, unitPrice: 90, lineTotal: 90, taxAmount: 13.5 });
    expect(parseMirrorPayload(p, 'invoice', SENDER)).toMatchObject({ ok: true });
  });
});

describe('buildCreditNotePayload', () => {
  it('is one line at the note subtotal and the exact VAT, with the invoice it credits named', () => {
    const p = buildCreditNotePayload({
      number: 'CN-7', date: '2026-11-19', currency: 'ZAR', subtotal: 200, taxAmount: 30, total: 230, taxRate: 15,
      reason: 'Returned router', creditsInvoiceNumber: 'INV-100', sender: { name: 'Blitz Fibre', vatNumber: null },
    });
    expect(p).toMatchObject({ kind: 'credit_note', number: 'CN-7', subtotal: 200, taxAmount: 30, total: 230, notes: 'Returned router', creditsInvoiceNumber: 'INV-100', pdf: null });
    expect(p.lines).toEqual([{ description: 'Returned router', quantity: 1, unitPrice: 200, taxRate: 15, taxAmount: 30, lineTotal: 200 }]);
  });

  it('names the line after the number when there is no reason', () => {
    const p = buildCreditNotePayload({
      number: 'CN-8', date: '2026-11-19', currency: 'ZAR', subtotal: 100, taxAmount: 0, total: 100, taxRate: 0,
      reason: null, creditsInvoiceNumber: null, sender: { name: 'Blitz Fibre', vatNumber: null },
    });
    expect(p.lines[0]!.description).toBe('Credit note CN-8');
  });
});

describe('parseMirrorPayload', () => {
  const good = () => buildInvoicePayload(invoice());

  it('accepts what the sender builds, with the sender prefix the message names', () => {
    const r = parseMirrorPayload(JSON.parse(JSON.stringify(good())), 'invoice', SENDER);
    expect(r).toMatchObject({ ok: true });
  });

  it.each([
    ['not an object', null],
    ['a wrong version', { ...good(), version: 2 }],
    ['the wrong kind', { ...good(), kind: 'credit_note' }],
    ['an empty number', { ...good(), number: '' }],
    ['a number over 50 characters', { ...good(), number: 'x'.repeat(51) }],
    ['a bad date', { ...good(), date: '2026-02-31' }],
    ['a bad due date', { ...good(), dueDate: 'tomorrow' }],
    ['no lines', { ...good(), lines: [] }],
    ['over 500 lines', { ...good(), lines: Array.from({ length: 501 }, () => good().lines[0]) }],
    ['a non-number total', { ...good(), total: '1150' }],
    ['a negative subtotal', { ...good(), subtotal: -1 }],
    ['a total that is not subtotal + VAT', { ...good(), total: 1151 }],
    ['a subtotal that is not the sum of the lines', { ...good(), subtotal: 999, total: 1149 }],
    ['a VAT that is not the sum of the line VATs', { ...good(), taxAmount: 140, total: 1140 }],
    ['a line with zero quantity', { ...good(), lines: [{ ...good().lines[0], quantity: 0 }, good().lines[1]] }],
    ['a line with a tax rate over 100', { ...good(), lines: [{ ...good().lines[0], taxRate: 101 }, good().lines[1]] }],
    ['a line whose total is not quantity x price', { ...good(), lines: [{ ...good().lines[0], lineTotal: 601 }, good().lines[1]] }],
    ['a description over 1000 characters', { ...good(), lines: [{ ...good().lines[0], description: 'x'.repeat(1001) }, good().lines[1]] }],
    ['a PDF path outside the sender prefix', { ...good(), pdf: { path: `${DOC}/${DOC}.pdf`, sha256: 'a'.repeat(64) } }],
    ['a PDF path that climbs', { ...good(), pdf: { path: `${SENDER}/../${DOC}.pdf`, sha256: 'a'.repeat(64) } }],
    ['a PDF with a short hash', { ...good(), pdf: { path: `${SENDER}/${DOC}.pdf`, sha256: 'abc' } }],
  ])('refuses %s', (_name, raw) => {
    expect(parseMirrorPayload(raw, 'invoice', SENDER)).toMatchObject({ ok: false });
  });

  it('a credit note carries no PDF', () => {
    const cn = buildCreditNotePayload({
      number: 'CN-9', date: '2026-11-19', currency: 'ZAR', subtotal: 100, taxAmount: 15, total: 115, taxRate: 15,
      reason: null, creditsInvoiceNumber: null, sender: { name: 'S', vatNumber: null },
    });
    expect(parseMirrorPayload(cn, 'credit_note', SENDER)).toMatchObject({ ok: true });
    expect(parseMirrorPayload({ ...cn, pdf: { path: `${SENDER}/${DOC}.pdf`, sha256: 'a'.repeat(64) } }, 'credit_note', SENDER))
      .toMatchObject({ ok: false });
  });
});

describe('payloadBlocker', () => {
  it('a ZAR document has none; a foreign one is refused with a plain sentence', () => {
    expect(payloadBlocker(buildInvoicePayload(invoice()))).toBeNull();
    const usd = payloadBlocker(buildInvoicePayload(invoice({ currency: 'USD' })));
    expect(usd).toMatch(/ZAR/);
  });
});
