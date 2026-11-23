/**
 * Intercompany P4-D, the final batch. M1 / M2: each of the seven bank tables makes an account money (no loan class) when a row OF THE ACCOUNT'S
 * OWN COMPANY names it: the function, the side form and the definer (the payer side not set up); a row of ANOTHER company naming the same GL
 * account changes nothing (no tenant can re-class another's loan account). L1: the receipt's cancel names the receipt as the database read it,
 * whatever string the caller passed (a 32-hex id with no hyphens).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cancelCustomerPayment } from '../../../src/modules/accounting/services/ar/customerPaymentService';
import { acct, api, asAppUser, co, U, wipeConnections } from './intercompany.helpers';
import { asService, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { accept, bodyFor, clearConnect, clearSetup, outcomeOf, sentClearable } from './allocation-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

const TABLES = ['bank_transactions', 'bank_accounts', 'bank_feed_connections', 'bank_statement_imports', 'bank_import_batches', 'bank_reconciliations', 'bank_transfer_link_log'] as const;
type Table = typeof TABLES[number];

/** One row of `table` of `company` naming GL account `account` (planted with foreign keys and guards off: replica mode, a superuser's). */
async function plant(table: Table, company: string, account: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const id = () => crypto.randomUUID();
    const q = (text: string, params: unknown[]) => client.query(text, params);
    switch (table) {
      case 'bank_transactions': await q("INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description) VALUES ($1, $2, DATE '2026-09-01', 10, 'IC r4')", [company, account]); break;
      case 'bank_accounts': await q("INSERT INTO bank_accounts(company_id, account_name, gl_account_id) VALUES ($1, 'IC r4', $2)", [company, account]); break;
      case 'bank_feed_connections': await q('INSERT INTO bank_feed_connections(bank_account_id, company_id) VALUES ($2, $1)', [company, account]); break;
      case 'bank_statement_imports': await q('INSERT INTO bank_statement_imports(company_id, bank_account_id, source_document_id) VALUES ($1, $2, $3)', [company, account, id()]); break;
      case 'bank_import_batches': await q("INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date) VALUES ($1, $2, DATE '2026-09-01')", [company, account]); break;
      case 'bank_reconciliations': await q("INSERT INTO bank_reconciliations(company_id, bank_account_id, statement_date, started_by) VALUES ($1, $2, DATE '2026-09-01', $3)", [company, account, U.ab]); break;
      case 'bank_transfer_link_log':
        // its guard is ENABLE ALWAYS (replica mode does not skip it): off for this one INSERT, back ALWAYS before COMMIT
        await q('ALTER TABLE bank_transfer_link_log DISABLE TRIGGER trg_bank_transfer_link_log_guard', []);
        await q(
          `INSERT INTO bank_transfer_link_log(company_id, link_batch_id, bank_transaction_id, bank_account_id, journal_entry_id, journal_line_id, trigger_source,
             prev_status, linked_row_updated_at) VALUES ($1, $3, $4, $2, $5, $6, 'page_load', 'imported', now())`, [company, account, id(), id(), id(), id()]);
        await q('ALTER TABLE bank_transfer_link_log ENABLE ALWAYS TRIGGER trg_bank_transfer_link_log_guard', []);
        break;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
const clearBankRows = async () => {
  for (const t of [...TABLES].reverse()) await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[co.A, co.B, co.C]]);
};
const loanClass = async (account: string, company: string) => (await pool.query('SELECT public.intercompany_is_loan_class($1, $2) AS ok', [account, company])).rows[0].ok as boolean;
const payerCap = (message: string) => asAppUser(pool, U.a, co.A, async (q) => (await q.query('SELECT cap FROM public.intercompany_allocation_clearable($1)', [message])).rows[0].cap as string | null);

beforeAll(() => clearSetup(pool), 60000);
afterAll(async () => { await clearBankRows(); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearBankRows();
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query("UPDATE gl_accounts SET account_type = 'asset', normal_balance = 'debit', account_subtype = 'other_current_asset' WHERE id = $1", [acct.aLoan]);
  await pool.query("UPDATE gl_accounts SET account_type = 'liability', normal_balance = 'credit', account_subtype = 'other_current_liability' WHERE id = $1", [acct.bLoan]);
  conn = await clearConnect(pool);
});

describe.each(TABLES)('%s', (table) => {
  it("a row of ANOTHER company naming the payer's loan account changes nothing: still a loan class, the clearing goes through", async () => {
    await plant(table, co.C, acct.bLoan);
    expect(await loanClass(acct.bLoan, co.B)).toBe(true);
    const sent = await sentClearable(pool, conn, { amount: 400 });
    expect(await payerCap(sent.message)).toBeNull();
    expect(outcomeOf(await accept(sent.message, bodyFor(sent)))).toMatchObject({ accepted: true });
  });

  it("a row of the account's own company: no loan class (the function), the payer side not set up (the definer), the side form refuses it", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    await plant(table, co.B, acct.bLoan);
    expect(await loanClass(acct.bLoan, co.B)).toBe(false);
    expect(await payerCap(sent.message)).toBe('payer_loan_unset');
    const other = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, 'IC B r4', 'liability', 'credit', true, 'other_current_liability')`, [other, co.B, `IR4${other.slice(0, 6)}`]);
    await plant(table, co.B, other);
    expect((await api.edit(U.b, co.B, conn, { loanAccountId: other })).state.statusCode).toBe(400);
  });
});

describe('L1', () => {
  it("the cancel names the receipt the database read: a 32-hex id with no hyphens cancels the clearing, it is not refused", async () => {
    const sent = await sentClearable(pool, conn, { amount: 400 });
    const out = outcomeOf(await accept(sent.message, bodyFor(sent)));
    const bare = out.paymentId!.replace(/-/g, '').toUpperCase();
    await asService(pool, U.a, co.A, () => cancelCustomerPayment(co.A, bare, U.a, 'undo'));
    expect((await pool.query('SELECT status FROM customer_payments WHERE id = $1', [out.paymentId])).rows[0].status).toBe('cancelled');
  });
});
