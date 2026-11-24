/**
 * Fixture for the intercompany P4-E (payer loan clearing) suites, on top of P4-D's. B is the PAYER: it clears its bill (the AP side of an ACTIVE
 * link to A's customer invoice, on the GROUP LOAN connection A <-> B whose two sides both mirror, pair cut-over 2026-01-01) against B's loan
 * account through the real route `POST /api/accounting/intercompany/loan-clearings` with real signed tokens: ONE contra supplier payment, journal
 * DR B's Accounts Payable control / CR B's loan account (a loan-class liability; A's is a loan-class asset). The P4-B hook then sends the
 * allocation message to A, and A's Accept (P4-D) clears A's invoice against A's loan account.
 * U.mab is a manager of B WITHOUT Approve on Suppliers & AP (a company_user_permissions row), U.avb a viewer of B.
 */
import type { Pool, PoolClient } from 'pg';
import loanClearingsRoute from '../../../pages/api/accounting/intercompany/loan-clearings';
import { runOwnedContext } from '../../../src/lib/afterCommit';
import { callRoute } from '../r035-approval.helpers';
import { acct, co, tokens, U } from './intercompany.helpers';
import { dataOf } from './mirror.helpers';
import { plantBill } from './allocation.helpers';
import { acceptAs, clearSetup } from './allocation-clear.helpers';

export { clearConnect, clearSetup } from './allocation-clear.helpers';

/** P4-D's fixture plus U.mab without Approve on Suppliers & AP in B. */
export async function payerSetup(pool: Pool): Promise<void> {
  await clearSetup(pool);
  await pool.query(
    `INSERT INTO company_user_permissions (company_id, user_id, module_key, can_read, can_write, can_approve)
     VALUES ($1, $2, 'suppliers', true, true, false) ON CONFLICT DO NOTHING`, [co.B, U.mab]);
}

export type PlantedBill = Awaited<ReturnType<typeof plantBill>>;
export { plantBill };

export interface ClearBody {
  billId: string; amount: number; postingDate: string;
  expected: { loanAccountId: string; linkId: string; amount: number; openAmount: number };
}

/** What the preview shows for `b` (R1 150 open, B's loan account), posted on 2026-09-10 unless overridden. */
export function clearBody(b: { bill: string; link: string | null }, over: { amount?: number; postingDate?: string; open?: number; loan?: string; link?: string; expectedAmount?: number } = {}): ClearBody {
  const amount = over.amount ?? 1150;
  return {
    billId: b.bill, amount, postingDate: over.postingDate ?? '2026-09-10',
    expected: { loanAccountId: over.loan ?? acct.bLoan, linkId: over.link ?? b.link ?? '', amount: over.expectedAmount ?? amount, openAmount: over.open ?? 1150 },
  };
}

const URL = '/api/accounting/intercompany/loan-clearings';
export const clearAs = (user: string, company: string, body: unknown, token = tokens[user]!) => callRoute(loanClearingsRoute, token, company, 'POST', body, URL);
export const clearBill = (body: unknown) => clearAs(U.b, co.B, body);
export const previewAs = (user: string, company: string, billId: string, token = tokens[user]!) =>
  callRoute(loanClearingsRoute, token, company, 'GET', undefined, `${URL}?billId=${billId}`, { billId });

export interface Cleared { cleared: boolean; billId: string; paymentId: string; paymentNumber: string; journalEntryId: string; messageId: string }
export const clearedOf = (r: { state: { body: unknown } }) => dataOf<Cleared>(r);
export const errorText = (r: { state: { body: unknown } }) => JSON.stringify(r.state.body);

/** The payer's books, as the cases judge them. */
export const payer = {
  journals: async (pool: Pool, company = co.B) => Number((await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1', [company])).rows[0].n),
  payments: async (pool: Pool, company = co.B) => Number((await pool.query('SELECT count(*)::int AS n FROM supplier_payments WHERE company_id = $1', [company])).rows[0].n),
  messages: async (pool: Pool) => Number((await pool.query("SELECT count(*)::int AS n FROM intercompany_messages WHERE from_company_id = $1 AND kind = 'allocation'", [co.B])).rows[0].n),
  open: async (pool: Pool, bill: string) => Number((await pool.query('SELECT (total_amount - COALESCE(amount_paid, 0))::float8 AS o FROM supplier_invoices WHERE id = $1', [bill])).rows[0].o),
  status: async (pool: Pool, bill: string) => String((await pool.query('SELECT status FROM supplier_invoices WHERE id = $1', [bill])).rows[0].status),
  ap: async (pool: Pool) => (await pool.query("SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'payable' AND is_system_account", [co.B])).rows[0].id as string,
  /** The allocation message B's hook sent for `payment` (null when none). */
  messageFor: async (pool: Pool, payment: string) => (await pool.query(
    `SELECT id, status, payload FROM intercompany_messages WHERE from_company_id = $1 AND kind = 'allocation' AND payload #>> '{payment,id}' = $2`,
    [co.B, payment])).rows[0] as { id: string; status: string; payload: Record<string, unknown> } | undefined,
};

/** The whole payer state a refused call must leave as it was. */
export async function snapshot(pool: Pool, bill: string) {
  return [await payer.journals(pool), await payer.payments(pool), await payer.messages(pool), await payer.open(pool, bill), await payer.journals(pool, co.A)];
}

/** `call` answers `status` and nothing of the payer (or the receiver) moved. */
export async function refusedUntouched(pool: Pool, bill: string, call: () => ReturnType<typeof clearBill>, status: number, text?: RegExp) {
  const before = await snapshot(pool, bill);
  const res = await call();
  if (res.state.statusCode !== status) throw new Error(`expected ${status}, got ${res.state.statusCode}: ${errorText(res)}`);
  if (text && !text.test(errorText(res))) throw new Error(`expected ${String(text)} in ${errorText(res)}`);
  const after = await snapshot(pool, bill);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`a refused call moved the books: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  return res;
}

/** A's Accept (P4-D) of the message B's clearing sent: what makes the receiver clear the same amount against its loan account. */
export const receiverAccepts = (message: string, invoice: string, amount: number, postingDate = '2026-09-12') =>
  acceptAs(U.a, co.A, message, { expectedLoanAccountId: acct.aLoan, invoiceId: invoice, amount, postingDate });

/**
 * A service call as `user` of `company` on app_user with a SESSION ID in the claims (what withAuth binds for a person's own GoTrue session, so
 * `currentSessionActor()` is 'self'), one transaction, committed unless `fn` throws.
 */
export async function asPerson<T>(pool: Pool, user: string, company: string, fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const claims = { sub: user, session_id: crypto.randomUUID() };
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    const out = await runOwnedContext({ client, userId: user, companyId: company, claims, afterCommit: [] }, () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
