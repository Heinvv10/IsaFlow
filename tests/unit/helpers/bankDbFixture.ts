/**
 * Shared fixtures for the DB-gated bank tests.
 *
 * These tests INSERT and DELETE real rows, so they refuse to run against the
 * production database — dev and production differ only in the database NAME on
 * the same host and port, which is a very small env slip.
 */
import type { PoolClient } from 'pg';

/** Production is named `isaflow`; dev/test are `isaflow_dev` / `isaflow_test`. */
const PROD_DB_NAME = 'isaflow';

export function assertNotProductionDb(): void {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, '').split('?')[0] ?? '';
  } catch {
    return; // Unparseable URL — isDbReachable will have skipped the test anyway.
  }
  if (name === PROD_DB_NAME) {
    throw new Error(
      `Refusing to run: DATABASE_URL points at the production database "${PROD_DB_NAME}". `
      + 'This test inserts and deletes bank transactions — point it at isaflow_dev.',
    );
  }
}

export interface BankFixture {
  companyId: string;
  bankAccountId: string;
  expenseAccountId: string;
}

/** A company that has both an active bank GL account and an active expense one. */
export async function findBankFixture(client: PoolClient): Promise<BankFixture | null> {
  const { rows } = await client.query<{ company_id: string; bank_id: string; exp_id: string }>(`
    SELECT b.company_id, b.id AS bank_id, e.id AS exp_id
    FROM gl_accounts b
    JOIN gl_accounts e
      ON e.company_id = b.company_id AND e.account_type = 'expense' AND e.is_active
    WHERE b.account_subtype = 'bank' AND b.is_active
    LIMIT 1
  `);
  const r = rows[0];
  return r ? { companyId: r.company_id, bankAccountId: r.bank_id, expenseAccountId: r.exp_id } : null;
}

/** Insert a committed `imported` bank transaction; returns its id. */
export async function insertImportedTx(
  client: PoolClient,
  fixture: BankFixture,
  description: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES ($1, $2, CURRENT_DATE, -101.00, $3, 'imported')
     RETURNING id`,
    [fixture.companyId, fixture.bankAccountId, description],
  );
  return rows[0]!.id;
}
