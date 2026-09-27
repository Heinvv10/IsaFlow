/**
 * The normalised CONTENT KEY of a receipt (R-088): vendor | date | total | VAT.
 *
 * The byte hash (`raw_bytes_sha256`) only catches a byte-identical re-upload.
 * The same slip photographed twice, or forwarded once by email and once by
 * WhatsApp (which re-encodes the image), is different bytes with the same
 * content — this key is what makes those two match. It is built from the
 * EXTRACTION, the same figures the posting routes book, so two documents with
 * one key would put the same expense and the same bank credit on the ledger.
 *
 * Pure: no DB, no clock. Returns null when a part the key cannot do without —
 * vendor, date or total — is unreadable, and the caller then has only the
 * byte hash to go on. A missing VAT figure is a part of the key ('none'), not
 * a reason to drop it: the posting routes book a receipt with no VAT read.
 */

const KEY_VERSION = 'v1';

/** Legal-form words that one extraction prints and another drops. */
const LEGAL_FORM = new Set(['pty', 'ltd', 'limited', 'proprietary', 'cc', 'inc', 'the']);

/**
 * `Waltons Stationery (Pty) Ltd.`, `WALTONS STATIONERY` and `Waltons  Stationery`
 * are one vendor. Accents are folded, `&` reads as `and`, punctuation and
 * legal-form words go, and the words are joined without spaces so `Pick n Pay`
 * and `PicknPay` agree.
 */
export function normaliseVendor(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !LEGAL_FORM.has(w));
  const joined = words.join('');
  return joined || null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A receipt date as `YYYY-MM-DD`. Accepts ISO (with or without a time), and
 * the South African day-first forms a till prints: `26/09/2026`, `26-09-26`,
 * `26.09.2026`, `26 Sep 2026`, `26 September 2026`.
 */
export function normaliseReceiptDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoDate(y, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase());
    return month < 0 ? null : isoDate(Number(m[3]), month + 1, Number(m[1]));
  }
  return null;
}

/**
 * An amount in cents. A number is taken as rands; a string may carry `R`/`ZAR`,
 * spaces as thousands separators, and either `,` or `.` as the decimal mark —
 * whichever comes LAST is the decimal mark when both appear, and a lone comma
 * is decimal only when exactly two digits follow it (`1 150,00`, not `1,150`).
 */
export function amountToCents(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    let s = value.replace(/zar|r/gi, '').replace(/[\s ]/g, '');
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (comma >= 0) {
      s = /,\d{2}$/.test(s) && s.indexOf(',') === comma ? s.replace(',', '.') : s.replace(/,/g, '');
    }
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    n = Number(s);
  } else {
    return null;
  }
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export interface ReceiptKeyInput {
  vendorName?: unknown;
  date?: unknown;
  totalAmount?: unknown;
  vatAmount?: unknown;
  referenceNumber?: unknown;
}

/** A printed slip/invoice number compared on its letters and digits only: `INV-00123` = `inv 00123`. */
export function normaliseReference(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
}

/**
 * Two receipts with one content key are still two receipts when BOTH printed
 * reference numbers were read and they differ — two identical coffees on one
 * day carry two slip numbers. A reference read on only one side decides
 * nothing: the same slip read twice can miss it once.
 */
export function referencesDistinguish(a: unknown, b: unknown): boolean {
  const ra = normaliseReference(a);
  const rb = normaliseReference(b);
  return ra !== null && rb !== null && ra !== rb;
}

/** `v1|vendor|YYYY-MM-DD|totalCents|vatCents-or-none`, or null when it cannot be built. */
export function receiptContentKey(extracted: ReceiptKeyInput): string | null {
  const vendor = normaliseVendor(extracted.vendorName);
  const date = normaliseReceiptDate(extracted.date);
  const total = amountToCents(extracted.totalAmount);
  if (!vendor || !date || total === null) return null;
  const vat = extracted.vatAmount === null || extracted.vatAmount === undefined
    ? 'none' : amountToCents(extracted.vatAmount) ?? 'none';
  return [KEY_VERSION, vendor, date, total, vat].join('|');
}
