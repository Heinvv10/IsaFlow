/**
 * Intercompany P2: the pure rules of a mirror message's payload. The sender builds a snapshot of its own invoice or credit note
 * (cents-exact, so the receiver's draft carries the same number, VAT and total); the receiver treats whatever it reads as
 * untrusted input and refuses a payload that does not add up, names a path outside the sender's storage prefix, or is not ZAR.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCreditNotePayload,
  buildInvoicePayload,
  parseMirrorPayload,
  payloadBlocker,
  type InvoiceSource,
} from '@/modules/accounting/services/intercompany/mirrorPayload';

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

  it('puts a header VAT that differs from the sum of the line VATs by a rounding cent or two on the largest line', () => {
    const p = buildInvoicePayload(invoice({
      subtotal: 100.01, taxAmount: 15.02, total: 115.03,
      lines: [
        { description: 'A', quantity: 1, unitPrice: 33.33, amount: 33.33, taxRate: 15 },
        { description: 'B', quantity: 1, unitPrice: 66.68, amount: 66.68, taxRate: 15 },
      ],
    }));
    expect(p.lines.reduce((s, l) => s + l.taxAmount, 0)).toBeCloseTo(15.02, 2);
    expect(parseMirrorPayload(p, 'invoice', SENDER)).toMatchObject({ ok: true });
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
