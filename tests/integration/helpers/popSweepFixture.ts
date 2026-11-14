/**
 * Shared fixture for the POP sweep suites (pop-match-sweep / pop-archive-sweep): companies with a bank
 * account, proof_of_payments filed straight into the tables (popIngest is pop-inbox-ingest's subject),
 * bank lines, and `asService`, which runs a sweep as the mirror cron's role (app_service) with its
 * statements on one ALS-bound connection, committed.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

export interface PopFixture {
  pool: Pool;
  companies: string[];
  bankAccount: Map<string, string>;
  /** A user who is a member of every fixture company (app_user's RLS admits a company only for its members). */
  member: string;
  /** Today in SAST minus `n` days, YYYY-MM-DD (the sweeps' clock). */
  day: (n: number) => string;
}

export async function setUpPopFixture(pool: Pool, companies: string[]): Promise<PopFixture> {
  const bankAccount = new Map<string, string>();
  const member = `pop-sweep-${crypto.randomUUID()}`;
  for (const [i, company] of companies.entries()) {
    await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2)', [company, `POP sweep ${i}`]);
    await pool.query('INSERT INTO company_users (company_id, user_id) VALUES ($1, $2)', [company, member]);
    const acc = crypto.randomUUID();
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
      VALUES ($1, $2, 'POPB', 'POP bank', 'asset', 'bank', 'debit')`, [acc, company]);
    bankAccount.set(company, acc);
  }
  const { rows: [r] } = await pool.query<{ today: string }>("SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS today");
  const today = new Date(`${r!.today}T00:00:00Z`);
  const day = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  return { pool, companies, bankAccount, member, day };
}

export async function tearDownPopFixture(fx: PopFixture): Promise<void> {
  const ids = fx.companies;
  for (const stmt of [
    'DELETE FROM pop_archive_copies WHERE company_id = ANY($1)',
    'DELETE FROM pop_archive_targets WHERE company_id = ANY($1)',
    'DELETE FROM proof_of_payment_matches WHERE company_id = ANY($1)',
    'DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = ANY($1))',
    'DELETE FROM proof_of_payments WHERE company_id = ANY($1)',
    'DELETE FROM captured_documents WHERE company_id = ANY($1)',
    'DELETE FROM bank_transactions WHERE company_id = ANY($1)',
    'DELETE FROM gl_accounts WHERE company_id = ANY($1)',
    'DELETE FROM companies WHERE id = ANY($1)',
  ]) await fx.pool.query(stmt, [ids]);
}

export interface PopSeed {
  beneficiary: string;
  date: string;
  amount?: string;
  matchedTo?: string;
}

/** A filed POP: its proof_of_payment document and its proof_of_payments row. */
export async function seedPop(fx: PopFixture, company: string, p: PopSeed): Promise<{ popId: string; documentId: string }> {
  const txn = `80${crypto.randomUUID().slice(0, 8).toUpperCase()}-01`;
  const { rows: [doc] } = await fx.pool.query<{ id: string }>(`INSERT INTO captured_documents (company_id, file_name, file_type, status,
      document_type, storage_bucket, storage_path, matched_bank_tx_id)
    VALUES ($1, $2, 'application/pdf', 'processed', 'proof_of_payment', 'test', $3, $4) RETURNING id`,
  [company, `ABSA POP ${txn}.pdf`, `pop/${txn}`, p.matchedTo ?? null]);
  const { rows: [pop] } = await fx.pool.query<{ id: string }>(`INSERT INTO proof_of_payments (company_id, captured_document_id, source,
      transaction_number, payment_date, amount, beneficiary, payer_profile)
    VALUES ($1, $2, 'absa_notice', $3, $4, $5, $6, 'EXAMPLE TRADING PTY LTD') RETURNING id`,
  [company, doc!.id, txn, p.date, p.amount ?? '3000.00', p.beneficiary]);
  return { popId: pop!.id, documentId: doc!.id };
}

export async function seedLine(fx: PopFixture, company: string, date: string, amount: string, description: string): Promise<string> {
  const { rows: [r] } = await fx.pool.query<{ id: string }>(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date,
      amount, description, reference, status, feed_state)
    VALUES ($1, $2, $3, $4, $5, 'SAGE3610911701|20261030-0126', 'imported', 'posted') RETURNING id`,
  [company, fx.bankAccount.get(company), date, amount, description]);
  return r!.id;
}

/** Runs `fn` as app_service (the cron's role), on one connection bound into ALS, and commits. */
export async function asService<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_service');
    const out = await als.run({ client, userId: 'system:mirror-scan', claims: {} }, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** The SQLSTATE `stmt` fails with as app_user in `company`'s context, or 'ok'. Rolled back either way. */
export async function asAppUser(fx: PopFixture, company: string, stmt: string, params: unknown[] = []): Promise<string> {
  const client = await fx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.member })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    const res = await client.query(stmt, params);
    return `ok:${res.rowCount ?? 0}`;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

export async function matchRow(pool: Pool, popId: string): Promise<{ outcome: string; candidate_bank_tx_ids: string[]; refusal: string | null } | null> {
  const { rows } = await pool.query('SELECT outcome, candidate_bank_tx_ids, refusal FROM proof_of_payment_matches WHERE proof_of_payment_id = $1', [popId]);
  return rows[0] ?? null;
}

export async function matchedLineOf(pool: Pool, documentId: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT matched_bank_tx_id FROM captured_documents WHERE id = $1', [documentId]);
  return rows[0]?.matched_bank_tx_id ?? null;
}
