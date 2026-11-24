/**
 * The payload of an intercompany `payment` message (F, migration 1031): the payer applied posted cash (a journal that did not credit its loan
 * account) to a bill linked to the receiver's customer invoice on a CASH connection. Built by the DATABASE (`intercompany_send_for_payment`)
 * from the payer's own rows; the receiver still reads it as untrusted input (another tenant wrote the rows it was built from): strict on
 * what it shows or acts on, unknown keys ignored. PURE: no database.
 */
import { isRealCalendarDate } from '@/lib/validation';

export interface PaymentPayload {
  version: 1;
  kind: 'payment';
  allocationId: string;
  amount: number;
  currency: string;
  /** The payer's payment: display text only, never an identity (the id is the payer's row, for the database to re-check). */
  payment: { id: string; number: string | null; reference: string | null; date: string; method: string | null };
  payerDocument: { type: 'supplier_invoice'; id: string; number: string | null; date: string | null };
  issuerDocument: { type: 'customer_invoice'; id: string };
  linkId: string;
}

export type ParsedPayment = { ok: true; payload: PaymentPayload } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const nullableText = (v: unknown, max: number): v is string | null => v === null || (typeof v === 'string' && v.length <= max);
/** Whole cents, positive, finite, bounded: a message carries no third decimal. */
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e12
  && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const isDate = (v: unknown): v is string => typeof v === 'string' && isRealCalendarDate(v);

export function parsePaymentPayload(raw: unknown): ParsedPayment {
  const no = (error: string): ParsedPayment => ({ ok: false, error });
  if (!isObject(raw)) return no('The message carries no payment');
  if (raw.version !== 1) return no('The message is from a newer version and cannot be read');
  if (raw.kind !== 'payment') return no('The message does not match its kind');
  if (!isUuid(raw.allocationId)) return no('The allocation reference is malformed');
  if (!isAmount(raw.amount)) return no('The amount is not a valid amount');
  if (typeof raw.currency !== 'string' || raw.currency.length !== 3) return no('The currency is missing');
  const pay = raw.payment;
  if (!isObject(pay) || !isUuid(pay.id)) return no('The payment reference is malformed');
  if (!isDate(pay.date)) return no('The payment date is not a date');
  if (!nullableText(pay.number, 50) || !nullableText(pay.reference, 255) || !nullableText(pay.method, 20)) return no('The payment details are malformed');
  const bill = raw.payerDocument;
  if (!isObject(bill) || bill.type !== 'supplier_invoice' || !isUuid(bill.id) || !nullableText(bill.number, 100)) return no("The payer's bill reference is malformed");
  if (bill.date !== null && !isDate(bill.date)) return no("The payer's bill date is not a date");
  const issuer = raw.issuerDocument;
  if (!isObject(issuer) || issuer.type !== 'customer_invoice' || !isUuid(issuer.id)) return no('The invoice reference is malformed');
  if (!isUuid(raw.linkId)) return no('The link reference is malformed');
  return {
    ok: true,
    payload: {
      version: 1, kind: 'payment', allocationId: raw.allocationId, amount: raw.amount, currency: raw.currency.toUpperCase(),
      payment: { id: pay.id, number: pay.number, reference: pay.reference, date: pay.date, method: pay.method },
      payerDocument: { type: 'supplier_invoice', id: bill.id, number: bill.number, date: (bill.date ?? null) as string | null },
      issuerDocument: { type: 'customer_invoice', id: issuer.id },
      linkId: raw.linkId,
    },
  };
}
