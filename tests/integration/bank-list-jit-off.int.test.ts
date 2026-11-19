// The Banking list (getBankTransactions) runs its page and count with JIT off. Its plan estimate (the settled-document
// evidence in TX_SELECT) can cross the JIT thresholds on some table statistics, and LLVM then spent ~20 s compiling a
// query that executes in ~300 ms. Statistics are not something a test can hold steady, so the condition is FORCED:
// inside the request transaction, jit = on and all three JIT thresholds = 0 (transaction-local, on this test's own
// connection: nothing to restore and nothing that reaches another suite on the cluster). Every list statement is then
// observed on the request's own client: the jit setting in force when it is sent must be off. Where the server has
// LLVM (pg_jit_available()), EXPLAIN also proves the forcing is real: the same statement plans WITH JIT outside the
// list and WITHOUT it inside. Through all four branches (reconciliation, account + status, account only, company-wide).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const [company, bank, user, recon] = [uuid(), uuid(), uuid(), uuid()];
const [t1, t2] = [uuid(), uuid()];

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
interface Seen { kind: 'page' | 'count'; jit: string; text: string; values: unknown[] }

/** EXPLAIN (FORMAT JSON) of a captured statement: does the plan carry a JIT section? */
async function plansWithJit(query: Query, s: Pick<Seen, 'text' | 'values'>): Promise<boolean> {
  const plan = (await query(`EXPLAIN (FORMAT JSON) ${s.text}`, s.values)).rows[0]!['QUERY PLAN'] as Record<string, unknown>[];
  return 'JIT' in plan[0]!;
}

/**
 * Run getBankTransactions the way a withAuth request does (BEGIN, app_user, the claims, the request client on ALS),
 * with JIT forced on at zero cost, and report the jit setting each list statement was sent under.
 */
async function listUnderForcedJit(filters: Parameters<typeof getBankTransactions>[1]) {
  const client = await pool.connect();
  const query = client.query.bind(client) as unknown as Query;
  const seen: Seen[] = [];
  let jitAvailable = false;
  let insideHasJit: boolean | null = null;
  try {
    await query('BEGIN');
    await query('SET LOCAL ROLE app_user');
    await query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    await query(`SELECT set_config('jit', 'on', true), set_config('jit_above_cost', '0', true),
                        set_config('jit_inline_above_cost', '0', true), set_config('jit_optimize_above_cost', '0', true)`);
    jitAvailable = (await query('SELECT pg_jit_available() AS ok')).rows[0]!.ok === true;
    // Observe on the request's own client: before a list statement is sent, read the jit it would run under. A list
    // statement under jit = on is refused here, before it is sent: the forced compile would take seconds.
    (client as unknown as { query: unknown }).query = async (text: unknown, values?: unknown[]) => {
      if (typeof text === 'string' && text.includes('FROM bank_transactions')) {
        const jit = String((await query("SELECT current_setting('jit') AS jit")).rows[0]!.jit);
        const s: Seen = { kind: /^\s*SELECT COUNT\(\*\) AS cnt\b/.test(text) ? 'count' : 'page', jit, text, values: values ?? [] };
        seen.push(s);
        if (jit !== 'off') throw new Error(`the list's ${s.kind} statement was about to run with jit = ${jit}`);
        if (jitAvailable && s.kind === 'page') insideHasJit = await plansWithJit(query, s);
      }
      return query(text as string, values);
    };
    const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
    const page = await als.run(ctx, () => getBankTransactions(company, filters));
    (client as unknown as { query: unknown }).query = query;
    const after = String((await query("SELECT current_setting('jit') AS jit")).rows[0]!.jit);
    const pageStmt = seen.find((s) => s.kind === 'page');
    const outsideHasJit = jitAvailable && pageStmt ? await plansWithJit(query, pageStmt) : null;
    return { page, seen, after, jitAvailable, insideHasJit, outsideHasJit };
  } finally {
    (client as unknown as { query: unknown }).query = query;
    await query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describeIfDb('Banking list — JIT off for the page and its count', () => {
  beforeAll(async () => {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'JIT off list']);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$2,'JOB','JIT Bank','asset','bank','debit')`, [bank, company]);
    for (const [id, amount] of [[t1, -100], [t2, -50]] as const) {
      await pool.query(
        `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,'2026-06-01',$4,'jit off fixture','imported')`, [id, company, bank, amount]);
    }
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query(
      `INSERT INTO bank_reconciliations(id,company_id,bank_account_id,statement_date,statement_balance,
         gl_balance,reconciled_balance,status,started_by)
       VALUES($1,$2,$3,'2026-06-30',0,0,0,'in_progress',$4)`, [recon, company, bank, user]);
    await pool.query('UPDATE bank_transactions SET reconciliation_id=$1 WHERE id = ANY($2::uuid[])', [recon, [t1, t2]]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, user]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM bank_reconciliations WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id=$1', [company]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      await pool.end();
    }
  });

  it.each([
    ['reconciliation', { reconciliationId: recon }],
    ['account + status', { bankAccountId: bank, status: 'imported' }],
    ['account only', { bankAccountId: bank }],
    ['company-wide', {}],
  ] as const)('%s: the page and the count run with jit off, and the request gets jit back', async (_branch, filters) => {
    const r = await listUnderForcedJit(filters);
    expect(r.page.transactions.map((t) => t.id).sort()).toEqual([t1, t2].sort());
    expect(r.page.total).toBe(2);
    expect(r.seen.map((s) => s.kind).sort()).toEqual(['count', 'page']);
    expect(r.seen.map((s) => s.jit)).toEqual(['off', 'off']);
    expect(r.after).toBe('on');
    if (r.jitAvailable) {
      expect(r.outsideHasJit).toBe(true);
      expect(r.insideHasJit).toBe(false);
    }
  });
});
