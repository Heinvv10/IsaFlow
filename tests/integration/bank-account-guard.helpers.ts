/**
 * Fixture for the bank-account guard suites (WP2 row 1, audit 2026-11-15):
 * every route that takes a bank account id from the request must refuse an id
 * that is not one of the company's active bank accounts, with a 400 and
 * nothing written. One company `f` (bankCompany: its bank, a second bank,
 * expenses, AP/AR, a supplier, an open 2026) plus the three ids it must refuse:
 *   - a REVENUE account of its own (the finding: any GL account became "the bank"),
 *   - ANOTHER company's bank account (the user is a member of both),
 *   - an INACTIVE bank account of its own,
 * and a credit card (a LIABILITY with a bank subtype) that must still be accepted.
 */
import type { Pool } from 'pg';
import { createUser } from './r035-approval.helpers';
import { journalCompany } from './r035-pr6.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

export interface GuardFixture {
  user: string;
  tokens: Record<string, string>;
  f: BankCompany;
  /** The foreign company's id. */
  g: string;
  revenue: string;
  foreignBank: string;
  inactiveBank: string;
  creditCard: string;
  companies: string[];
}

async function account(pool: Pool, c: string, code: string, type: string, normal: string, subtype: string | null,
  active = true): Promise<string> {
  return (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [c, `${code}${c.slice(0, 6)}`, `BAG ${code}`, type, normal, active, subtype],
  )).rows[0].id as string;
}

export async function guardFixture(pool: Pool): Promise<GuardFixture> {
  const tokens: Record<string, string> = {};
  const companies: string[] = [];
  const user = await createUser(pool, tokens);
  const f = await bankCompany(pool, [[user, 'admin']], companies);
  const g = await journalCompany(pool, [[user, 'admin']], companies);
  return {
    user, tokens, f, g: g.c, companies, foreignBank: g.bank,
    revenue: await account(pool, f.c, 'RV', 'revenue', 'credit', null),
    inactiveBank: await account(pool, f.c, 'IB', 'asset', 'debit', 'bank', false),
    creditCard: await account(pool, f.c, 'CC', 'liability', 'credit', 'bank'),
  };
}

/** The ids every guarded route must refuse, named for the assertion message. */
export const refusedIds = (x: GuardFixture): Array<[string, string]> => [
  ['a revenue account', x.revenue], ["another company's bank account", x.foreignBank], ['an inactive bank account', x.inactiveBank],
];

/** Rows a refused request must not have written, in either company. */
export async function writtenRows(pool: Pool, x: GuardFixture): Promise<Record<string, number>> {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*) FROM bank_transactions WHERE company_id = ANY($1))::INT AS bank_transactions,
            (SELECT count(*) FROM bank_reconciliations WHERE company_id = ANY($1))::INT AS bank_reconciliations,
            (SELECT count(*) FROM bank_import_batches WHERE company_id = ANY($1))::INT AS bank_import_batches,
            (SELECT count(*) FROM bank_statement_imports WHERE company_id = ANY($1))::INT AS bank_statement_imports,
            (SELECT count(*) FROM captured_documents WHERE company_id = ANY($1))::INT AS captured_documents,
            (SELECT count(*) FROM gl_journal_entries WHERE company_id = ANY($1))::INT AS gl_journal_entries`,
    [[x.f.c, x.g]]);
  return r as Record<string, number>;
}

/**
 * An account stored with `subtype` spelled as it was before trg_gl_accounts_normalise_subtype existed (the trigger
 * rewrites it on every write, so only a legacy row can still hold e.g. 'Bank Account'). Triggers off for the insert.
 */
export async function legacySpelledAccount(pool: Pool, c: string, subtype: string): Promise<string> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    const id = (await db.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
       VALUES ($1,$2,'BAG legacy spelling','asset','debit',true,$3) RETURNING id`, [c, `LG${c.slice(0, 6)}`, subtype],
    )).rows[0].id as string;
    await db.query('COMMIT');
    return id;
  } finally { db.release(); }
}

/** A read statement import (status `extracted`, one row) on `bankAccountId`, as an upload made before the guard left it. */
export async function seedStatementImport(pool: Pool, x: GuardFixture, bankAccountId: string, tag: string): Promise<string> {
  const doc = (await pool.query(
    `INSERT INTO captured_documents(company_id, file_name, file_type, document_type, uploaded_by)
     VALUES($1,$2,'pdf','statement',$3) RETURNING id`, [x.f.c, `${tag}.pdf`, x.user])).rows[0].id as string;
  const rows = [{ date: '2026-09-07', description: `BAG OCR ${tag}`, reference: null, amount: -55, runningBalance: null,
    isDuplicate: false, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 }];
  return (await pool.query(
    `INSERT INTO bank_statement_imports(company_id, bank_account_id, source_document_id, period_start, period_end, row_count,
       status, extraction_summary, created_by)
     VALUES($1,$2,$3,DATE '2026-09-01',DATE '2026-09-30',1,'extracted',$4::jsonb,$5) RETURNING id`,
    [x.f.c, bankAccountId, doc, JSON.stringify({ rows }), x.user])).rows[0].id as string;
}

export const messageOf =(res: { state: { body: unknown } }) =>
  (res.state.body as { error?: { message?: string } }).error?.message ?? '';

export async function cleanupGuardFixture(pool: Pool, x: GuardFixture | undefined): Promise<void> {
  if (!x) { await pool.end(); return; }
  await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = ANY($1)', [x.companies]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [x.companies]);
  await cleanupBankControlsA(pool, x.companies, [x.user]);
}
