/**
 * Bank controls step 2, slice a (importer ≠ allocator; reversal gating): a
 * company that can post account, transfer and supplier allocations (two
 * expense accounts, two banks, a payable, an open 2026), import batches with a
 * recorded importer, statement / feed / hand-keyed lines, the real
 * bank-transactions-action route, and MCP tools run the way the bearer pipeline
 * runs them (app_user, claims with no session id, the company GUC).
 */
import type { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import type { McpTool } from '../../src/lib/mcp/types';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { callRoute } from './r035-approval.helpers';
import { cleanupPr6, journalCompany, type JournalCompany } from './r035-pr6.helpers';

export interface BankCompany extends JournalCompany { bank2: string; supplier: string; customer: string }

/** journalCompany plus a payable and a receivable, a second bank (the transfer arm), a supplier and a customer. */
export async function bankCompany(pool: Pool, members: [string, string][], companies: string[]): Promise<BankCompany> {
  const f = await journalCompany(pool, members, companies);
  const tag = f.c.slice(0, 6);
  await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
     VALUES ($1,$2,'BC AP','liability','credit',true,true,'payable'),($1,$3,'BC AR','asset','debit',true,true,'receivable')`,
    [f.c, `AP${tag}`, `AR${tag}`]);
  const bank2 = (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,'BC Bank 2','asset','debit',true,'bank') RETURNING id`, [f.c, `B2${tag}`])).rows[0].id as string;
  const supplier = (await pool.query('INSERT INTO suppliers(company_id,name) VALUES($1,$2) RETURNING id',
    [f.c, `BC supplier ${tag}`])).rows[0].id as string;
  const customer = (await pool.query('INSERT INTO customers(company_id,name) VALUES($1,$2) RETURNING id',
    [f.c, `BC customer ${tag}`])).rows[0].id as string;
  clearSystemAccountCache(f.c);
  return { ...f, bank2, supplier, customer };
}

export async function enforce(pool: Pool, company: string, by: string, types: string[]): Promise<void> {
  for (const type of types) {
    await pool.query(
      `INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,$2,$3)
       ON CONFLICT (company_id, document_type) DO NOTHING`, [company, type, by]);
  }
}
export const PAY_TYPES = ['supplier_payment', 'payment_batch'];

/** A statement batch whose importer is `importedBy`. */
export async function plantBatch(pool: Pool, f: JournalCompany, importedBy: string | null, channel = 'upload'): Promise<string> {
  return (await pool.query(
    `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by, import_channel)
     VALUES($1,$2,DATE '2026-09-30',1,$3,$4) RETURNING id`, [f.c, f.bank, importedBy, channel])).rows[0].id as string;
}

/** A line: from `batch` (imported), a live feed (`'feed'`) or keyed by hand (`null`). */
export async function plantLine(pool: Pool, f: JournalCompany, batch: string | 'feed' | null, amount = -1500): Promise<string> {
  let feed: string | null = null;
  if (batch === 'feed') {
    feed = (await pool.query(
      `INSERT INTO bank_feed_connections(company_id, bank_account_id, provider, status) VALUES($1,$2,'extension','active') RETURNING id`,
      [f.c, f.bank])).rows[0].id as string;
  }
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id,
       bank_feed_connection_id)
     VALUES($1,$2,DATE '2026-09-01',$3,'BC line','imported',$4,$5) RETURNING id`,
    [f.c, f.bank, amount, batch === 'feed' ? null : batch, feed])).rows[0].id as string;
}

export const lineStatus = async (pool: Pool, id: string) =>
  (await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [id])).rows[0].status as string;

export function actionRoute(tokens: Record<string, string>) {
  return (user: string, company: string, body: Record<string, unknown>) => callRoute(
    bankTransactionsAction as never, tokens[user]!, company, 'POST', body, '/api/accounting/bank-transactions-action');
}

export const refusalOf = (res: { state: { statusCode: number; body: unknown } }) => {
  const body = res.state.body as { error?: { message?: string; details?: { reason?: string } } };
  return { status: res.state.statusCode, reason: body.error?.details?.reason, message: body.error?.message ?? '' };
};

export type McpReply = { isError?: boolean; content: { text: string }[] };

/** `fn` in one transaction run as the bearer pipeline runs a token: app_user, claims without a session id, the company GUC. */
export async function asToken<T>(pool: Pool, user: string, company: string, fn: () => Promise<T>,
  /** A person in their own cookie session (a session id), rather than a token. */
  opts: { session?: boolean } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: user, role: 'authenticated', company_id: company, ...(opts.session ? { session_id: crypto.randomUUID() } : {}) };
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    const out = await als.run({ client, userId: user, companyId: company, claims } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** A registry of `tools`, called through asToken. */
export function mcpCaller(pool: Pool, tools: McpTool[]) {
  const registry = new McpRegistry();
  for (const tool of tools) registry.register(tool);
  return (user: string, company: string, name: string, args: Record<string, unknown>): Promise<McpReply> =>
    asToken(pool, user, company, async () => (await registry.call(name, args,
      { userId: user, companyId: company, scopes: ['write:bank-tx', 'write:post', 'write:invoices'], companyRole: 'owner', tokenJti: 'bc-a', oauthAppId: null },
    )) as McpReply);
}

/** What slice a's tests leave behind, then PR6's teardown. */
export async function cleanupBankControlsA(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_auto_post_runs WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_auto_post_settings WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_allocation_batch_lines WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_allocation_batches WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_statement_imports WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE supplier_payments SET gl_journal_entry_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_feed_connections WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = ANY($1)', [companies]);
  await cleanupPr6(pool, companies, users);
}

/**
 * Gives a planted line the batch an import would have written it with. 877
 * fixes a line's provenance once written (any UPDATE of import_batch_id is
 * refused), so a fixture that seeds the line first sets it with triggers off.
 */
export async function setLineBatchAsImported(pool: Pool, line: string, batch: string): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query('UPDATE bank_transactions SET import_batch_id = $2 WHERE id = $1', [line, batch]);
    await db.query('COMMIT');
  } finally { db.release(); }
}
