// Shared harness for the migration 978 transfer link log suites: request transactions as withAuth opens them, the
// line's link fields, its log rows, and the outcome of an undo or a raw statement.
import type { Pool, PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getPoolForTests } from '@/lib/neon';
import { TransferLinkUndoError } from '@/modules/accounting/services/bank/bankTransferLinkUndo';

type Ctx = Parameters<typeof als.run>[0];
const FIELDS = `status, allocation_type, transfer_journal_entry_id, matched_journal_line_id, counterparty_account_id,
  allocated_entity_name, allocation_rule_id, allocation_rule_name`;

/** A request transaction as withAuth opens one: app_user, the member's claims, the active company. */
export async function asApp<T>(companyId: string, sub: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const ctx = { client, userId: sub, companyId, claims: { sub } } as unknown as Ctx;
    const out = await als.run(ctx, () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

/** The same request transaction as the table owner (RLS not applied): proves the code's own company scoping. */
export async function asOwner<T>(companyId: string, sub: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, userId: sub, companyId, claims: {} } as unknown as Ctx, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

export async function lineFields(pool: Pool, txId: string) {
  return (await pool.query(`SELECT ${FIELDS} FROM bank_transactions WHERE id = $1`, [txId])).rows[0];
}

export async function logRowsOf(pool: Pool, txId: string) {
  return (await pool.query('SELECT * FROM bank_transfer_link_log WHERE bank_transaction_id = $1 ORDER BY linked_at', [txId])).rows;
}

/** The undo's refusal code, or 'ok'. */
export async function undoErr(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) {
    if (err instanceof TransferLinkUndoError) return err.code;
    throw err;
  }
  return 'ok';
}

/** The SQLSTATE a statement fails with, or 'ok'; in a savepoint so the session stays usable. */
export async function codeOf(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await c.query('SAVEPOINT probe');
  try { await c.query(text, params); await c.query('RELEASE SAVEPOINT probe'); return 'ok'; } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return String((err as { code?: string }).code);
  }
}

/** Two tenants, each with one owner. */
export async function seedTenants(pool: Pool, t: { company: string; other: string; user: string; otherUser: string }) {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [t.company, 'Link log fixture', t.other, 'Link log other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true),($3,$4,'admin',true)",
    [t.user, `${t.user}@test.local`, t.otherUser, `${t.otherUser}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
    [t.company, t.user, t.other, t.otherUser]);
}
