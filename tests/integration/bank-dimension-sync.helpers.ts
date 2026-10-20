/**
 * Bank-row dimension sync (PR #698 round 2): a company whose bank rows are
 * allocated by the REAL allocate_bank_transaction tool (VAT line and all), two
 * FNOs with a project each and two business units, and the three MCP tools
 * the sync touches, run the way the bearer pipeline runs them.
 */
import { Pool } from 'pg';
import { McpRegistry } from '../../src/lib/mcp/registry';
import type { McpTool } from '../../src/lib/mcp/types';
import { allocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { splitAllocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankSplit';
import { reverseDimensionTagBatchTool, tagJournalLinesTool } from '../../src/lib/mcp/tools/writeDimensionTags';
import { syncBankDimensionsTool } from '../../src/lib/mcp/tools/writeBankDimensionSync';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { reverseJournalEntry } from '../../src/modules/accounting/services/gl/journalEntryPostingService';
import { getBankTransactions } from '../../src/modules/accounting/services/bank/bankTransactionQueryService';
import { asToken, bankCompany, cleanupBankControlsA, type BankCompany, type McpReply } from './bank-controls-a.helpers';
import { createUser } from './r035-approval.helpers';

export interface DimSet { cc1: string | null; cc2: string | null; bu: string | null }
export const NONE: DimSet = { cc1: null, cc2: null, bu: null };

export interface SyncFixture extends BankCompany {
  user: string;
  cc: { F1: string; F2: string; P1: string; P2: string };
  bu: { B1: string; B2: string };
  vatInput: string;
  /** A second expense account of the same company, for two-line journals. */
  expC: string;
}

const TOOLS: McpTool[] = [allocateBankTransactionTool, splitAllocateBankTransactionTool, tagJournalLinesTool, syncBankDimensionsTool, reverseDimensionTagBatchTool];

export function mcpAs(pool: Pool, scopes = ['write:bank-tx', 'write:post', 'write:invoices', 'write:journals']) {
  const registry = new McpRegistry();
  for (const tool of TOOLS) registry.register(tool);
  return (user: string, company: string, name: string, args: Record<string, unknown>): Promise<McpReply> =>
    asToken(pool, user, company, async () => (await registry.call(name, args,
      { userId: user, companyId: company, scopes, companyRole: 'owner', tokenJti: 'bds', oauthAppId: null })) as McpReply);
}

export const json = <T = Record<string, unknown>>(r: McpReply): T => JSON.parse(r.content[0]!.text) as T;
let seq = 0;
export const newKey = (tag = 'bds'): string => `${tag}-${Date.now()}-${seq++}`;

export async function syncFixture(pool: Pool, tokens: Record<string, string>, companies: string[]): Promise<SyncFixture> {
  const user = await createUser(pool, tokens);
  const f = await bankCompany(pool, [[user, 'admin']], companies);
  const tag = f.c.slice(0, 6);
  const id = () => crypto.randomUUID();
  const cc = { F1: id(), F2: id(), P1: id(), P2: id() };
  for (const [cid, code, parent, type] of [
    [cc.F1, 'F1', null, 'cc1'], [cc.F2, 'F2', null, 'cc1'], [cc.P1, 'P1', cc.F1, 'cc2'], [cc.P2, 'P2', cc.F2, 'cc2'],
  ] as const) {
    await pool.query('INSERT INTO cost_centres(id, company_id, code, name, parent_id, cc_type) VALUES ($1,$2,$3,$4,$5,$6)',
      [cid, f.c, `${code}${tag}`, `Centre ${code}`, parent, type]);
  }
  const bu = { B1: id(), B2: id() };
  for (const [bid, code] of [[bu.B1, 'B1'], [bu.B2, 'B2']] as const) {
    await pool.query('INSERT INTO business_units(id, company_id, code, name) VALUES ($1,$2,$3,$4)', [bid, f.c, `${code}${tag}`, `Unit ${code}`]);
  }
  const acct = async (code: string, name: string, type: string, normal: string, subtype: string | null, system = false) =>
    (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,is_system_account,account_subtype)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id`, [f.c, `${code}${tag}`, name, type, normal, system, subtype])).rows[0].id as string;
  const vatInput = await acct('VI', 'BDS VAT input', 'asset', 'debit', 'vat_input', true);
  const expC = await acct('EC', 'BDS expense C', 'expense', 'debit', null);
  clearSystemAccountCache(f.c);
  return { ...f, user, cc, bu, vatInput, expC };
}

/** A hand-keyed bank row (imported, unallocated) of `amount` on `date`. */
export async function plantBankTx(pool: Pool, f: SyncFixture, amount: number, date = '2026-09-01', id?: string): Promise<string> {
  return (await pool.query(
    `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES(COALESCE($5::UUID, gen_random_uuid()),$1,$2,$3::DATE,$4,'BDS line','imported') RETURNING id`,
    [f.c, f.bank, date, amount, id ?? null])).rows[0].id as string;
}

export interface AllocOpts { txId?: string; amount?: number; date?: string; vat?: 'standard'; cc1?: string; cc2?: string; bu?: string; account?: string }

/** A bank row allocated by allocate_bank_transaction to one expense account; returns the row and its journal. */
export async function allocate(pool: Pool, f: SyncFixture, opts: AllocOpts = {}): Promise<{ tx: string; journal: string }> {
  const tx = await plantBankTx(pool, f, opts.amount ?? -1150, opts.date, opts.txId);
  const res = await mcpAs(pool)(f.user, f.c, 'allocate_bank_transaction', {
    transaction_id: tx, alloc_type: 'account', contra_account_id: opts.account ?? f.expA,
    ...(opts.vat ? { vat_code: opts.vat } : {}),
    ...(opts.cc1 ? { cc1: opts.cc1 } : {}), ...(opts.cc2 ? { cc2: opts.cc2 } : {}), ...(opts.bu ? { bu: opts.bu } : {}),
    idempotency_key: newKey('alloc'),
  });
  if (res.isError) throw new Error(`allocate: ${res.content[0]!.text}`);
  // Allocation stamps the bank row too (bankAllocationService); blank it, so the row is as one allocated before the dimensions existed.
  await pool.query('UPDATE bank_transactions SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE id = $1', [tx]);
  return { tx, journal: await journalOf(pool, tx) };
}

/** A bank row split across several expense lines by split_allocate_bank_transaction; each part may carry its own dimensions. */
export async function splitAllocate(pool: Pool, f: SyncFixture, parts: { account: string; amount: number; cc2?: string; bu?: string }[],
  date = '2026-09-01'): Promise<{ tx: string; journal: string }> {
  const tx = await plantBankTx(pool, f, -parts.reduce((n, p) => n + p.amount, 0), date);
  const res = await mcpAs(pool)(f.user, f.c, 'split_allocate_bank_transaction', {
    transaction_id: tx, idempotency_key: newKey('split'),
    lines: parts.map((p) => ({ contra_account_id: p.account, amount: p.amount, ...(p.cc2 ? { cc2: p.cc2 } : {}), ...(p.bu ? { bu: p.bu } : {}) })),
  });
  if (res.isError) throw new Error(`split: ${res.content[0]!.text}`);
  await pool.query('UPDATE bank_transactions SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE id = $1', [tx]);
  return { tx, journal: await journalOf(pool, tx) };
}

/** A supplier payment (AP + bank, no dimensions by design) allocated by the real tool. */
export async function supplierPayment(pool: Pool, f: SyncFixture, date = '2026-09-01'): Promise<{ tx: string; journal: string }> {
  const tx = await plantBankTx(pool, f, -500, date);
  const res = await mcpAs(pool)(f.user, f.c, 'allocate_bank_transaction', {
    transaction_id: tx, alloc_type: 'supplier', entity_id: f.supplier, auto_apply: 'none', idempotency_key: newKey('pay'),
  });
  if (res.isError) throw new Error(`supplier payment: ${res.content[0]!.text}`);
  return { tx, journal: await journalOf(pool, tx) };
}

/**
 * A posted manual journal with two expense lines and a bank leg, the lines INSERTED highest id first (so a scan in
 * physical order reaches the higher id first, the opposite of id order). Returns the two expense line ids, high and low.
 */
export async function plantOppositeOrderLines(pool: Pool, f: SyncFixture): Promise<{ hi: string; lo: string }> {
  const rand = () => crypto.randomUUID().slice(24);
  const hi = `ffffffff-ffff-4fff-8fff-${rand()}`;
  const lo = `00000000-0000-4000-8000-${rand()}`;
  const je = crypto.randomUUID();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(`INSERT INTO gl_journal_entries(id, company_id, entry_number, entry_date, description, source, status, created_by)
                    VALUES($1,$2,$3,DATE '2026-09-01','opposite order','manual','posted',$4)`, [je, f.c, `OPP-${je.slice(0, 8)}`, f.user]);
    for (const [id, account, debit, credit] of [[hi, f.expA, 10, 0], [lo, f.expC, 20, 0], [crypto.randomUUID(), f.bank, 0, 30]] as const) {
      await db.query(`INSERT INTO gl_journal_lines(id, journal_entry_id, company_id, gl_account_id, debit, credit, description)
                      VALUES($1,$2,$3,$4,$5,$6,'opp')`, [id, je, f.c, account, debit, credit]);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
  return { hi, lo };
}

/** Reverse a journal through the real reversal service (it stamps reversed_at and posts a contra; status stays 'posted'). Returns the contra's id. */
export async function reverseJournal(pool: Pool, f: SyncFixture, journal: string): Promise<string> {
  const res = await asToken(pool, f.user, f.c, () => reverseJournalEntry(f.c, journal, f.user));
  return (res as unknown as { id: string }).id;
}

export async function setJournalStatus(pool: Pool, journal: string, status: string): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query('UPDATE gl_journal_entries SET status = $2 WHERE id = $1', [journal, status]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}

export async function journalOf(pool: Pool, tx: string): Promise<string> {
  return (await pool.query(
    `SELECT jl.journal_entry_id FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id WHERE bt.id = $1`,
    [tx])).rows[0].journal_entry_id as string;
}

export interface LineRow { id: string; account: string; subtype: string | null; cc1: string | null; cc2: string | null; bu: string | null }

export async function linesOf(pool: Pool, journal: string): Promise<LineRow[]> {
  return (await pool.query(
    `SELECT jl.id, jl.gl_account_id AS account, a.account_subtype AS subtype, jl.cc1_id AS cc1, jl.cc2_id AS cc2, jl.bu_id AS bu
     FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id WHERE jl.journal_entry_id = $1 ORDER BY jl.id`,
    [journal])).rows as LineRow[];
}

export const lineOn = async (pool: Pool, journal: string, account: string): Promise<LineRow> =>
  (await linesOf(pool, journal)).find((l) => l.account === account)!;

export async function bankDims(pool: Pool, tx: string): Promise<DimSet> {
  return (await pool.query('SELECT cc1_id AS cc1, cc2_id AS cc2, bu_id AS bu FROM bank_transactions WHERE id = $1', [tx])).rows[0] as DimSet;
}

/** Straight onto the journal line, as books tagged before the write-through existed (no batch, no bank row). */
export async function setLineDims(pool: Pool, line: string, d: Partial<DimSet>): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query('UPDATE gl_journal_lines SET cc1_id = $2, cc2_id = $3, bu_id = $4 WHERE id = $1',
      [line, d.cc1 ?? null, d.cc2 ?? null, d.bu ?? null]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally { db.release(); }
}

/** Straight onto the bank row (the row's own tags, as the allocation form or a person sets them). */
export async function setBankDims(pool: Pool, tx: string, d: Partial<DimSet>): Promise<void> {
  await pool.query('UPDATE bank_transactions SET cc1_id = $2, cc2_id = $3, bu_id = $4 WHERE id = $1', [tx, d.cc1 ?? null, d.cc2 ?? null, d.bu ?? null]);
}

/** What the Banking screen shows for one row. */
export async function displayOf(pool: Pool, f: SyncFixture, tx: string) {
  return asToken(pool, f.user, f.c, async () => {
    const page = await getBankTransactions(f.c, { bankAccountId: f.bank, limit: 100 });
    const row = page.transactions.find((t) => t.id === tx)!;
    return { source: row.dimensionSource, cc1: row.cc1Code, cc2: row.cc2Code, bu: row.buCode };
  });
}

export async function cleanupSync(pool: Pool, companies: string[], users: string[]): Promise<void> {
  await pool.query('DELETE FROM dimension_tag_batch_bank_rows WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM dimension_tag_batch_lines WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM dimension_tag_batches WHERE company_id = ANY($1)', [companies]);
  await pool.query('UPDATE bank_transactions SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE company_id = ANY($1)', [companies]);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query('UPDATE gl_journal_lines SET cc1_id = NULL, cc2_id = NULL, bu_id = NULL WHERE company_id = ANY($1)', [companies]);
    await db.query('COMMIT');
  } finally { db.release(); }
  await pool.query('DELETE FROM business_units WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, users);
}

// ── Lock-wait probes: they THROW when nothing ever blocked, so a lock-order assertion can never pass unexercised ──

const NEVER_BLOCKED = 'the session under test never blocked on the lock; the lock-order premise was not exercised';

/** The pid of a checked-out connection. */
export const pidOf = async (c: { query: (t: string) => Promise<{ rows: { pid: number }[] }> }): Promise<number> =>
  (await c.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;

/** Wait (up to 5s) until a session is blocked by `blockerPid`; THROWS if none ever is. `db` must not be a pool whose connections are all checked out. */
export async function waitBlockedBy(db: Pool, blockerPid: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const waiting = await db.query('SELECT 1 FROM pg_stat_activity WHERE $1::INT = ANY(pg_blocking_pids(pid))', [blockerPid]);
    if (waiting.rowCount) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${NEVER_BLOCKED} (nothing blocked by pid ${blockerPid} within 5s)`);
}

/** Wait (up to 5s) until a session of application `appName` waits on a lock; THROWS if none ever does. */
export async function waitForLockWaitBy(db: Pool, appName: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const waiting = await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = $1", [appName]);
    if (waiting.rowCount) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${NEVER_BLOCKED} (no ${appName} session waited on a lock within 5s)`);
}

/**
 * Sessions that cannot walk the primary key: with index and bitmap scans off, an UNORDERED locking select returns (and so
 * locks) rows in physical order. Per-connection startup options, so no other session or file is touched.
 */
export const physicalPool = (appName: string): Pool => new Pool({
  connectionString: process.env.DATABASE_URL, max: 3, application_name: appName,
  options: '-c enable_indexscan=off -c enable_bitmapscan=off -c enable_indexonlyscan=off',
});

/** The ids an UNORDERED locking select returns in a `physical` session, i.e. the order it would lock them. */
export async function unorderedLockOrder(physical: Pool, text: string, values: unknown[]): Promise<string[]> {
  const c = await physical.connect();
  try {
    await c.query('BEGIN');
    return (await c.query(text, values)).rows.map((r: { id: string }) => r.id);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
