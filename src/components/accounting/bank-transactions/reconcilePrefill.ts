/**
 * The values the statement panel's "Reconcile" link puts in the query of /accounting/bank-reconciliation/new
 * (bankAccountId, statementDate, statementBalance). A link is untrusted input, so each is validated on its own and a
 * bad one is dropped, leaving that field at the form's default: a UUID, a real calendar date, a figure with at most
 * two decimals.
 */

import { UUID_RE } from '@/lib/validation';

export interface ReconcilePrefill {
  bankAccountId?: string;
  statementDate?: string;
  statementBalance?: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Up to 12 whole digits (R999 999 999 999.99): cents then stay far inside 2^53, so the number prints back as typed. */
const AMOUNT = /^-?\d{1,12}(\.\d{1,2})?$/;

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A real calendar date, by arithmetic: no Date, so no timezone can move it. */
function isRealDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return d <= (mo === 2 && leap ? 29 : DAYS[mo - 1]!);
}

export function parseReconcilePrefill(query: Record<string, string | string[] | undefined>): ReconcilePrefill {
  const out: ReconcilePrefill = {};
  const id = one(query.bankAccountId);
  if (id && UUID_RE.test(id)) out.bankAccountId = id;
  const date = one(query.statementDate);
  if (date && isRealDate(date)) out.statementDate = date;
  const bal = one(query.statementBalance);
  if (bal && AMOUNT.test(bal)) out.statementBalance = Number(bal);
  return out;
}
