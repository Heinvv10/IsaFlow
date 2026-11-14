/**
 * Shared fixture for the POP sweep suites (pop-match-sweep*, pop-archive-sweep): companies with a bank
 * account, proof_of_payments filed straight into the tables (popIngest is pop-inbox-ingest's subject),
 * bank lines, and `asService`, which runs a sweep as the mirror cron's role (app_service) with its
 * statements on one ALS-bound connection, committed.
 */
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';

export interface PopFixture {
  pool: Pool;
  companies: string[];
  /** Each company's main bank account (imported up to today: see `cover`). */
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
    bankAccount.set(company, await addBankAccount(pool, company));
  }
  const { rows: [r] } = await pool.query<{ today: string }>("SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::text AS today");
  const today = new Date(`${r!.today}T00:00:00Z`);
  const day = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString().slice(0, 10);
  const fx = { pool, companies, bankAccount, member, day };
  for (const company of companies) await cover(fx, company);
  return fx;
}

export async function addBankAccount(pool: Pool, company: string): Promise<string> {
  const acc = crypto.randomUUID();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance)
    VALUES ($1, $2, $3, 'POP bank', 'asset', 'bank', 'debit')`, [acc, company, `PB${acc.slice(0, 6)}`]);
  return acc;
}

/**
 * A posted line dated today, so the account reads as imported past every window that has ended (a window ends
 * payment_date + 3; one ending today or later is not imported yet, whatever the account holds).
 */
export async function cover(fx: PopFixture, company: string, account = fx.bankAccount.get(company)!): Promise<string> {
  return seedLine(fx, company, fx.day(0), '-0.01', 'BANK CHARGE', { account });
}

export async function tearDownPopFixture(fx: PopFixture): Promise<void> {
  const ids = fx.companies;
  for (const stmt of [
    'DELETE FROM pop_archive_attempts WHERE company_id = ANY($1)',
    'DELETE FROM pop_archive_copies WHERE company_id = ANY($1)',
    'DELETE FROM pop_archive_targets WHERE company_id = ANY($1)',
    'DELETE FROM proof_of_payment_matches WHERE company_id = ANY($1)',
    'DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = ANY($1))',
    'DELETE FROM proof_of_payments WHERE company_id = ANY($1)',
    'DELETE FROM captured_documents WHERE company_id = ANY($1)',
    'DELETE FROM bank_transactions WHERE company_id = ANY($1)',
    'DELETE FROM bank_feed_connections WHERE company_id = ANY($1)',
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

/** A bank line; `feedState` other than 'posted' comes from a (fixture) feed connection, as the table requires. */
export async function seedLine(fx: PopFixture, company: string, date: string, amount: string, description: string | null,
  opts: { account?: string; feedState?: 'posted' | 'pending' | 'removed' } = {}): Promise<string> {
  const account = opts.account ?? fx.bankAccount.get(company)!;
  const state = opts.feedState ?? 'posted';
  let conn: string | null = null;
  if (state !== 'posted') {
    const { rows: [c] } = await fx.pool.query<{ id: string }>(`INSERT INTO bank_feed_connections (company_id, bank_account_id, provider)
      VALUES ($1, $2, 'test_provider') RETURNING id`, [company, account]);
    conn = c!.id;
  }
  const { rows: [r] } = await fx.pool.query<{ id: string }>(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date,
      amount, description, reference, status, feed_state, bank_feed_connection_id, provider_transaction_id)
    VALUES ($1, $2, $3, $4, $5, 'SAGE3610911701|20261030-0126', 'imported', $6, $7, $8) RETURNING id`,
  [company, account, date, amount, description, state, conn, conn ? `ptx-${crypto.randomUUID()}` : null]);
  return r!.id;
}

/** Runs `fn` as app_service (the cron's role), on one connection bound into ALS, and commits. `setup` runs first. */
export async function asService<T>(pool: Pool, fn: () => Promise<T>, setup: string[] = []): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_service');
    for (const stmt of setup) await client.query(stmt);
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

/** The SQLSTATE `stmt` fails with as `role` in `company`'s context, or `ok:<rows>`. Rolled back either way. */
export async function asAppUser(fx: PopFixture, company: string, stmt: string, params: unknown[] = [],
  role: 'app_user' | 'app_service' = 'app_user'): Promise<string> {
  const client = await fx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
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
