/**
 * Reads an ABSA "Notice of payment" PDF's text layer (pdf-parse output) into the fields a
 * proof of payment needs. Pure: no I/O.
 *
 * ABSA sends two layouts (business banking and Absa Online). Both print one "Label: value"
 * per line; they differ in the date form (2026-11-13 / 20261113), the thousands separator
 * (3 000.00 / 3,000.00) and a possessive on the beneficiary labels. A notice is refused,
 * never guessed, when a required field is missing, unreadable, or printed twice with two
 * different values: a refused notice is left for a person, a wrong one would be filed.
 */

export interface AbsaPop {
  /** The ABSA banking profile the notice is addressed to ("Dear ..."): who made the payment. */
  payerProfile: string;
  transactionNumber: string;
  /** YYYY-MM-DD */
  paymentDate: string;
  /** The paying account's nickname as ABSA prints it ("Payment made from"), not its number. */
  payerAccountName: string | null;
  beneficiary: string;
  beneficiaryBank: string | null;
  amountCents: number;
  reference: string | null;
}

export type AbsaPopReason =
  | 'not_absa_notice'
  | 'missing_payer_profile'
  | 'missing_transaction_number'
  | 'missing_payment_date'
  | 'missing_beneficiary'
  | 'missing_amount';

export type AbsaPopParse = { ok: true; pop: AbsaPop } | { ok: false; reason: AbsaPopReason };

const LABELS = {
  transactionNumber: /^transaction number$/,
  paymentDate: /^payment date$/,
  payerAccountName: /^payment made from$/,
  beneficiary: /^payment made to$/,
  beneficiaryBank: /^beneficiary(?:'s)? bank name$/,
  amount: /^for the amount of$/,
  reference: /^reference on beneficiary statement$/,
} as const;

type Field = keyof typeof LABELS;

/** Each field's value; null when absent, `false` when printed twice with different values. */
function readFields(text: string): Record<Field, string | null | false> {
  const out = Object.fromEntries(Object.keys(LABELS).map((k) => [k, null])) as Record<Field, string | null | false>;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:]{3,60}?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const label = m[1]!.toLowerCase().replace(/\s+/g, ' ');
    const value = m[2]!;
    for (const field of Object.keys(LABELS) as Field[]) {
      if (!LABELS[field].test(label) || value === '') continue;
      const seen = out[field];
      out[field] = seen === null || seen === value ? value : false;
    }
  }
  return out;
}

function isoDate(raw: string): string | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** "3 000.00" / "3,000.00" / "3000.00" → 300000. Anything else (no cents, decimal comma, sign, currency) → null. */
function amountCents(raw: string): number | null {
  if (!/^(?:\d{1,3}(?:[ ,]\d{3})+|\d+)\.\d{2}$/.test(raw)) return null;
  const cents = Number(raw.replace(/[ ,.]/g, ''));
  return Number.isSafeInteger(cents) ? cents : null;
}

function text(v: string | null | false): string | null {
  return typeof v === 'string' ? v : null;
}

export function parseAbsaPopText(pdfText: string): AbsaPopParse {
  if (!/\babsa\b/i.test(pdfText) || !/notice of payment/i.test(pdfText)) return { ok: false, reason: 'not_absa_notice' };
  const f = readFields(pdfText);

  const profiles = new Set([...pdfText.matchAll(/^\s*Dear\s+(.+?)\s*,?\s*$/gim)].map((m) => m[1]!));
  if (profiles.size !== 1) return { ok: false, reason: 'missing_payer_profile' };
  const payerProfile = [...profiles][0]!;

  const transactionNumber = text(f.transactionNumber);
  if (!transactionNumber || !/^[A-Z0-9][A-Z0-9-]{4,40}$/.test(transactionNumber)) {
    return { ok: false, reason: 'missing_transaction_number' };
  }
  const paymentDate = text(f.paymentDate) && isoDate(text(f.paymentDate)!);
  if (!paymentDate) return { ok: false, reason: 'missing_payment_date' };
  const beneficiary = text(f.beneficiary);
  if (!beneficiary) return { ok: false, reason: 'missing_beneficiary' };
  const cents = text(f.amount) && amountCents(text(f.amount)!);
  if (!cents) return { ok: false, reason: 'missing_amount' };

  return {
    ok: true,
    pop: {
      payerProfile,
      transactionNumber,
      paymentDate,
      payerAccountName: text(f.payerAccountName),
      beneficiary,
      beneficiaryBank: text(f.beneficiaryBank),
      amountCents: cents,
      reference: text(f.reference),
    },
  };
}
