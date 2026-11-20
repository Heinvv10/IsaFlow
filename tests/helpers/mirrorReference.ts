/**
 * REFERENCE builder of an intercompany invoice / credit-note payload: what `intercompany_build_payload` (migration 1019) must produce.
 * Production does not use it (the DATABASE builds the payload, the sender never does); the suites compare the database's payload with it,
 * so a change to the SQL builder that drifts from the parser's rules is a red test.
 */
import type { MirrorLine, MirrorPayload, MirrorPdf } from '@/modules/accounting/services/intercompany/mirrorPayload';

export interface InvoiceSource {
  number: string;
  date: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  notes: string | null;
  sender: { name: string; vatNumber: string | null };
  lines: Array<{ description: string; quantity: number; unitPrice: number; amount: number; taxRate: number }>;
  pdf: MirrorPdf | null;
}

export interface CreditNoteSource {
  number: string;
  date: string;
  currency: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  taxRate: number;
  reason: string | null;
  creditsInvoiceNumber: string | null;
  sender: { name: string; vatNumber: string | null };
}


const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): number => c / 100;
const round2 = (n: number): number => money(cents(n));
const rate100 = (pct: number): number => Math.round(pct * 100);
const UNITS = 10_000;

/**
 * Split a header VAT over the lines, in cents, the way a ledger does: each line's own VAT is its amount at its rate, and the cents
 * the header VAT is above or below the sum of those, whatever their number, go to the lines with the largest (or, when the header is
 * lower, the smallest) fractional cent, one cent each, round and round. A header that is the invoice rate on the subtotal
 * (ROUND(sum x rate)) is never more than half a cent per line from its lines' own VAT, so each line is within one cent of its rate.
 */
export function allocateLineVat(lineCents: readonly number[], rates: readonly number[], headerVatCents: number): number[] {
  const n = lineCents.length;
  if (n === 0) return [];
  const ideal = lineCents.map((c, i) => c * rate100(rates[i]!));
  const out = ideal.map((u) => Math.floor(u / UNITS));
  const frac = ideal.map((u, i) => ({ i, f: u - out[i]! * UNITS }));
  let rest = headerVatCents - out.reduce((s, c) => s + c, 0);
  const up = [...frac].sort((x, y) => y.f - x.f || x.i - y.i);
  const down = [...frac].sort((x, y) => x.f - y.f || y.i - x.i);
  for (let k = 0; rest !== 0; k = (k + 1) % n) {
    if (rest > 0) { out[up[k]!.i]! += 1; rest -= 1; } else { out[down[k]!.i]! -= 1; rest += 1; }
  }
  return out;
}

const chars = (s: string, max: number): string => [...s].slice(0, max).join('');
/** Text the receiver's parser accepts: trimmed, cut at its limit; an empty line description becomes a placeholder, empty notes null. */
const description = (s: string): string => chars(s.trim(), 1000) || '(no description)';
const optional = (s: string | null, max: number): string | null => (s && s.trim() ? chars(s.trim(), max) : null);

export function buildInvoicePayload(src: InvoiceSource): MirrorPayload {
  const lineCents = src.lines.map((l) => cents(l.amount));
  const vat = allocateLineVat(lineCents, src.lines.map((l) => l.taxRate), cents(src.taxAmount));
  const lines: MirrorLine[] = src.lines.map((l, i) => {
    // The receiver multiplies quantity by price; a line that does not multiply out (to the cent) - a discounted line - is sent as one unit.
    const multiplies = cents(l.quantity * l.unitPrice) === lineCents[i] && l.unitPrice >= 0 && l.quantity > 0;
    return {
      description: description(l.description),
      quantity: multiplies ? l.quantity : 1,
      unitPrice: multiplies ? l.unitPrice : money(lineCents[i]!),
      taxRate: l.taxRate,
      taxAmount: money(vat[i]!),
      lineTotal: money(lineCents[i]!),
    };
  });
  return {
    version: 1, kind: 'invoice', number: src.number, date: src.date, dueDate: src.dueDate, currency: src.currency,
    subtotal: round2(src.subtotal), taxAmount: round2(src.taxAmount), total: round2(src.total),
    senderName: chars(src.sender.name, 200), senderVatNumber: optional(src.sender.vatNumber, 50), notes: optional(src.notes, 2000),
    lines, pdf: src.pdf, creditsInvoiceNumber: null, groupTransactionId: null,
  };
}

export function buildCreditNotePayload(src: CreditNoteSource): MirrorPayload {
  return {
    version: 1, kind: 'credit_note', number: src.number, date: src.date, dueDate: null, currency: src.currency,
    subtotal: round2(src.subtotal), taxAmount: round2(src.taxAmount), total: round2(src.total),
    senderName: chars(src.sender.name, 200), senderVatNumber: optional(src.sender.vatNumber, 50), notes: optional(src.reason, 2000),
    lines: [{
      description: src.reason?.trim() ? description(src.reason) : `Credit note ${src.number}`,
      quantity: 1, unitPrice: round2(src.subtotal), taxRate: src.taxRate, taxAmount: round2(src.taxAmount), lineTotal: round2(src.subtotal),
    }],
    pdf: null, creditsInvoiceNumber: optional(src.creditsInvoiceNumber, 50), groupTransactionId: null,
  };
}

