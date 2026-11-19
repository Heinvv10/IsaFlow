/**
 * The payload of an intercompany invoice / credit-note message (P2), and the rules around it. PURE: no database.
 *
 * The SENDER builds a snapshot of its own document, cents-exact, so the receiver's draft carries the same number, VAT and
 * total. The RECEIVER treats whatever it reads as untrusted input (a sender is another tenant): `parseMirrorPayload` refuses
 * a payload that does not add up, names a storage path outside the sender's own prefix, or is malformed; `payloadBlocker`
 * names what stops an otherwise valid payload being accepted (ZAR only). Everything is held in whole cents.
 */
import { isRealCalendarDate } from '@/lib/validation';

export type MirrorKind = 'invoice' | 'credit_note';

export interface MirrorLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
}

/** The sender's sealed PDF: `<sender company id>/<document id>.pdf` in the customer-invoices bucket (the receiver reads it from there only). */
export interface MirrorPdf { path: string; sha256: string }

export interface MirrorPayload {
  version: 1;
  kind: MirrorKind;
  number: string;
  date: string;
  dueDate: string | null;
  currency: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  senderName: string;
  senderVatNumber: string | null;
  notes: string | null;
  lines: MirrorLine[];
  pdf: MirrorPdf | null;
  /** A credit note: the number of the invoice it credits (a reference only; the receiver's note is not linked to a bill). */
  creditsInvoiceNumber: string | null;
  /** Group pair: the sender's `intercompany_transactions` row that the receiver marks matched on accept. */
  groupTransactionId: string | null;
}

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
/** The rounding every figure here shares: half up on the absolute value, as the rest of the app's 2 dp rounding. */
const round2 = (n: number): number => money(cents(n));

/** A rate as whole hundredths of a percent (15 -> 1500), so VAT is worked in integers: line cents x rate100 is in ten-thousandths of a cent. */
const rate100 = (rate: number): number => Math.round(rate * 100);
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
    const multiplies = cents(l.quantity * l.unitPrice) === lineCents[i];
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

export type ParsedPayload = { ok: true; payload: MirrorPayload } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e12 && cents(v) / 100 === round2(v);
const text = (v: unknown, max: number, min = 0): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const nullableText = (v: unknown, max: number): v is string | null => v === null || text(v, max);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PDF_NAME = new RegExp(`^${UUID}\\.pdf$`, 'i');
const bad = (error: string): ParsedPayload => ({ ok: false, error });

function parseLine(raw: unknown, i: number, checkVat: boolean): MirrorLine | string {
  const at = `Line ${i + 1}`;
  if (!isObject(raw)) return `${at} is not an object`;
  const { description, quantity, unitPrice, taxRate, taxAmount, lineTotal } = raw;
  if (!text(description, 1000, 1)) return `${at} has no description`;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || !(quantity > 0) || quantity >= 1e8) return `${at} quantity must be positive`;
  if (!isMoney(unitPrice) || unitPrice < 0) return `${at} price is not a valid amount`;
  if (typeof taxRate !== 'number' || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) return `${at} tax rate must be 0 to 100`;
  if (!isMoney(taxAmount) || taxAmount < 0) return `${at} VAT is not a valid amount`;
  if (!isMoney(lineTotal) || lineTotal < 0) return `${at} total is not a valid amount`;
  if (cents(quantity * unitPrice) !== cents(lineTotal)) return `${at} total is not quantity times price`;
  // A line's VAT is its amount at its rate, to within the cent a header's rounding can put on it (allocateLineVat).
  // (A credit note's one line IS its header, whose totals the database ties to the note; its stored VAT may be an exact figure.)
  if (checkVat && Math.abs(cents(taxAmount) * UNITS - cents(lineTotal) * rate100(taxRate)) > UNITS) return `${at} VAT is not its amount at its rate`;
  return { description, quantity, unitPrice, taxRate, taxAmount, lineTotal };
}

function parsePdf(raw: unknown, kind: MirrorKind, senderCompanyId: string): MirrorPdf | null | string {
  if (raw === null || raw === undefined) return null;
  if (kind !== 'invoice') return 'A credit note carries no PDF';
  if (!isObject(raw)) return 'The PDF reference is malformed';
  const { path, sha256 } = raw;
  if (typeof path !== 'string') return 'The PDF path is malformed';
  const [prefix, name, ...rest] = path.split('/');
  if (rest.length > 0 || prefix?.toLowerCase() !== senderCompanyId.toLowerCase() || !name || !PDF_NAME.test(name)) {
    return 'The PDF is not in the sending company\'s storage';
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return 'The PDF hash is malformed';
  return { path, sha256 };
}

/**
 * Validate what a sender wrote. `senderCompanyId` is the message's own `from_company_id` (never a payload field): a PDF path
 * must sit under it. Totals must add up to the cent, because the receiver's draft is built from the lines and must equal
 * what the sender posted.
 */
export function parseMirrorPayload(raw: unknown, kind: MirrorKind, senderCompanyId: string): ParsedPayload {
  if (!isObject(raw)) return bad('The message carries no document');
  if (raw.version !== 1) return bad('The message is from a newer version and cannot be read');
  if (raw.kind !== kind) return bad('The message does not match its kind');
  if (!text(raw.number, 50, 1)) return bad('The document number is missing or too long');
  if (typeof raw.date !== 'string' || !isRealCalendarDate(raw.date)) return bad('The document date is not a date');
  if (raw.dueDate !== null && (typeof raw.dueDate !== 'string' || !isRealCalendarDate(raw.dueDate))) return bad('The due date is not a date');
  if (!text(raw.currency, 3, 3)) return bad('The currency is missing');
  if (!isMoney(raw.subtotal) || raw.subtotal < 0 || !isMoney(raw.taxAmount) || raw.taxAmount < 0 || !isMoney(raw.total) || raw.total < 0) {
    return bad('A total is not a valid amount');
  }
  if (!text(raw.senderName, 200) || !nullableText(raw.senderVatNumber, 50) || !nullableText(raw.notes, 2000)) return bad('The sender details are malformed');
  if (!nullableText(raw.creditsInvoiceNumber ?? null, 50)) return bad('The credited invoice number is malformed');
  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 500) return bad('The document needs between 1 and 500 lines');
  const lines: MirrorLine[] = [];
  for (const [i, l] of raw.lines.entries()) {
    const line = parseLine(l, i, kind === 'invoice');
    if (typeof line === 'string') return bad(line);
    lines.push(line);
  }
  if (kind === 'credit_note' && lines.length !== 1) return bad('A credit note is one line');
  const sumLines = lines.reduce((s, l) => s + cents(l.lineTotal), 0);
  const sumTax = lines.reduce((s, l) => s + cents(l.taxAmount), 0);
  if (sumLines !== cents(raw.subtotal)) return bad('The line totals do not add up to the subtotal');
  if (sumTax !== cents(raw.taxAmount)) return bad('The line VAT does not add up to the document VAT');
  if (cents(raw.subtotal) + cents(raw.taxAmount) !== cents(raw.total)) return bad('The total is not the subtotal plus VAT');
  const pdf = parsePdf(raw.pdf, kind, senderCompanyId);
  if (typeof pdf === 'string') return bad(pdf);
  const gtx = raw.groupTransactionId ?? null;
  if (gtx !== null && !(typeof gtx === 'string' && new RegExp(`^${UUID}$`, 'i').test(gtx))) return bad('The group transaction reference is malformed');
  return {
    ok: true,
    payload: {
      version: 1, kind, number: raw.number, date: raw.date, dueDate: raw.dueDate as string | null, currency: raw.currency.toUpperCase(),
      subtotal: raw.subtotal, taxAmount: raw.taxAmount, total: raw.total, senderName: raw.senderName,
      senderVatNumber: raw.senderVatNumber as string | null, notes: raw.notes as string | null, lines, pdf,
      creditsInvoiceNumber: (raw.creditsInvoiceNumber ?? null) as string | null, groupTransactionId: gtx as string | null,
    },
  };
}

/** What stops a valid payload being accepted, as a sentence a person reads; null when nothing does. ZAR only (no FX in the mirror). */
export function payloadBlocker(p: MirrorPayload): string | null {
  if (p.currency !== 'ZAR') {
    return `This ${p.kind === 'invoice' ? 'invoice' : 'credit note'} is in ${p.currency}. Intercompany mirroring is ZAR only: reject it, and capture it by hand.`;
  }
  return null;
}
