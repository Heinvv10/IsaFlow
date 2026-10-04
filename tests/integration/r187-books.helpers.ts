/**
 * R-187: what a replay must leave untouched in company A's books, shared by the r187 suites.
 */
import { A, pool } from './r181-settlement.helpers';

/** Company A's books as a whole: net Bank, net AR, the expense, and how many receipts and journals exist. */
export async function books(): Promise<Record<string, string | number>> {
  const { rows } = await pool.query<{ bank: string; ar: string; expense: string; journals: number; receipts: number }>(
    `SELECT COALESCE(SUM(l.debit - l.credit) FILTER (WHERE g.account_subtype = 'bank'), 0)::text AS bank,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE g.account_subtype = 'receivable'), 0)::text AS ar,
            COALESCE(SUM(l.debit - l.credit) FILTER (WHERE g.account_subtype = 'admin_expense'), 0)::text AS expense,
            (SELECT count(*)::int FROM gl_journal_entries WHERE company_id = $1) AS journals,
            (SELECT count(*)::int FROM customer_payments WHERE company_id = $1) AS receipts
     FROM gl_journal_lines l JOIN gl_accounts g ON g.id = l.gl_account_id WHERE g.company_id = $1`, [A.id]);
  return rows[0]!;
}

/** Journals carrying the reference in their reference column: the fee leg's (the receipt's own carries none). */
export const feeJournals = async (ref: string): Promise<number> => (await pool.query<{ n: number }>(
  'SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1 AND reference = $2', [A.id, ref])).rows[0]!.n;
