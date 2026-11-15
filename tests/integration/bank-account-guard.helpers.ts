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

export const messageOf = (res: { state: { body: unknown } }) =>
  (res.state.body as { error?: { message?: string } }).error?.message ?? '';

export async function cleanupGuardFixture(pool: Pool, x: GuardFixture | undefined): Promise<void> {
  if (!x) { await pool.end(); return; }
  await pool.query('UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = ANY($1)', [x.companies]);
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [x.companies]);
  await cleanupBankControlsA(pool, x.companies, [x.user]);
}
