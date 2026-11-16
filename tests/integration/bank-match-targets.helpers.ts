/**
 * Fixtures for the match-target suites (audit rows 4 and 8): journals planted with any shape and status, the
 * bank-match-confirm route, and what a refused match must leave behind on the statement line.
 */
import type { Pool } from 'pg';
import bankMatchConfirm from '../../pages/api/accounting/bank-match-confirm';
import { callRoute } from './r035-approval.helpers';
import type { BankCompany } from './bank-controls-a.helpers';

/** One journal line: account, debit, credit. */
export type PlantedLine = [account: string, debit: number, credit: number];

/**
 * A journal of `lines` by `createdBy`, dated 2026-09-01, drafted then moved to `status` (the status UPDATE is what the
 * balance trigger checks).
 */
export async function plantJe(pool: Pool, company: string, createdBy: string, lines: PlantedLine[],
  opts: { status?: 'posted' | 'draft'; source?: string } = {}): Promise<{ je: string; lines: string[] }> {
  const je = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,description,source,status,created_by)
     VALUES($1,$2,$3,DATE '2026-09-01','Match target journal',$4,'draft',$5)`,
    [je, company, `MT-${je.slice(0, 8)}`, opts.source ?? 'manual', createdBy]);
  const ids: string[] = [];
  for (const [account, debit, credit] of lines) {
    ids.push((await pool.query(
      `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
       VALUES($1,$2,$3,$4,$5,'mt') RETURNING id`, [company, je, account, debit, credit])).rows[0].id as string);
  }
  if ((opts.status ?? 'posted') === 'posted') {
    await pool.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]);
  }
  return { je, lines: ids };
}

/** A hand-keyed `imported` statement line on `bank`. */
export async function plantBankLine(pool: Pool, company: string, bank: string, amount: number): Promise<string> {
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES($1,$2,DATE '2026-09-01',$3,'MT line','imported') RETURNING id`, [company, bank, amount])).rows[0].id as string;
}

/** The line's link state: a refused match leaves it exactly as imported. */
export const linkOf = async (pool: Pool, id: string) => (await pool.query(
  `SELECT status, matched_journal_line_id AS line, linked_po_id AS po, allocation_type AS type
   FROM bank_transactions WHERE id = $1`, [id])).rows[0] as { status: string; line: string | null; po: string | null; type: string | null };

export const UNTOUCHED = { status: 'imported', line: null, po: null, type: null };

export function confirmRoute(tokens: Record<string, string>) {
  return (user: string, company: string, body: { bankTransactionId: string; candidateType: string; candidateId: string }) =>
    callRoute(bankMatchConfirm as never, tokens[user]!, company, 'POST', body, '/api/accounting/bank-match-confirm');
}

/** Journals and payments the company holds — a refusal before the first write posts none. */
export const writesOf = async (pool: Pool, f: BankCompany) => (await pool.query(
  `SELECT (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id = $1)::INT AS journals,
          (SELECT COUNT(*) FROM supplier_payments WHERE company_id = $1)::INT AS payments`, [f.c])).rows[0] as
  { journals: number; payments: number };
