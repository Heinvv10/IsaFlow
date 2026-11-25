// W8 JIT census (wave 7, JT). The Banking list already runs under withJitOff (bank-list-jit-off.int). The other
// readers whose plan can cross jit_above_cost run under it too, and this pins each one: inside the request
// transaction jit = on and all three JIT thresholds = 0 (transaction-local), and every data statement the function
// sends is observed on the request's own client: the jit setting in force when it is sent must be off. A statement
// sent under jit = on is refused here before it reaches the server (the forced compile would take seconds).
// The request gets jit back afterwards. Wrapped: getBankTransactionById, getAllBankTransactionsForExport, and the
// integrity checks invoices_null_due_date, test_records_in_production, invoices_without_revenue_line (the plan costs
// measured on dev are in the PR body).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getBankTransactionById } from '@/modules/accounting/services/bank/bankTxSingleLine';
import { getAllBankTransactionsForExport } from '@/modules/accounting/services/bank/bankTxExportAll';
import { invoicesNullDueDate, invoicesWithoutRevenueLine } from '@/modules/accounting/services/gl/integrityChecks/documentChecks';
import { testRecordsInProduction } from '@/modules/accounting/services/gl/integrityChecks/vatChecks';

const url = process.env.DATABASE_URL ?? '';
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
const uuid = () => crypto.randomUUID();
const [company, other, bank, user, tx] = [uuid(), uuid(), uuid(), uuid(), uuid()];

type Query = (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
// Only withJitOff's own two statements are skipped (read the setting, put it back); anything else is a data statement.
const SETTING_READS = /^\s*SELECT (current_setting\('jit'\) AS jit\s*$|set_config\('jit', )/;

/** Run `fn` the way a withAuth request does, with JIT forced on at zero cost; report the jit each data statement saw. */
async function underForcedJit<T>(fn: () => Promise<T>) {
  const client = await pool.connect();
  const query = client.query.bind(client) as unknown as Query;
  const jits: string[] = [];
  try {
    await query('BEGIN');
    await query('SET LOCAL ROLE app_user');
    await query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    await query(`SELECT set_config('jit', 'on', true), set_config('jit_above_cost', '0', true),
                        set_config('jit_inline_above_cost', '0', true), set_config('jit_optimize_above_cost', '0', true)`);
    (client as unknown as { query: unknown }).query = async (text: unknown, values?: unknown[]) => {
      if (typeof text === 'string' && !SETTING_READS.test(text)) {
        const jit = String((await query("SELECT current_setting('jit') AS jit")).rows[0]!.jit);
        jits.push(jit);
        if (jit !== 'off') throw new Error(`a data statement was about to run with jit = ${jit}: ${text.slice(0, 80)}`);
      }
      return query(text as string, values);
    };
    const ctx = { client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0];
    const result = await als.run(ctx, fn);
    (client as unknown as { query: unknown }).query = query;
    const after = String((await query("SELECT current_setting('jit') AS jit")).rows[0]!.jit);
    return { result, jits, after };
  } finally {
    (client as unknown as { query: unknown }).query = query;
    await query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describeIfDb('JIT census: bank single line, export-all and the heavy integrity checks run with jit off', () => {
  beforeAll(async () => {
    for (const [id, name] of [[company, 'JIT census A'], [other, 'JIT census B']] as const) {
      await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    }
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance)
       VALUES($1,$2,'JCB','JIT Bank','asset','bank','debit')`, [bank, company]);
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,feed_state)
       VALUES($1,$2,$3,'2026-06-01',-100,'jit census fixture','imported','posted')`, [tx, company, bank]);
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM bank_transactions WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[company, other]]);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
    } finally {
      await pool.end();
    }
  });

  it('getBankTransactionById: one statement, jit off, own line found, another tenant sees nothing', async () => {
    const r = await underForcedJit(async () => ({ own: await getBankTransactionById(company, tx), foreign: await getBankTransactionById(other, tx) }));
    expect(r.result.own?.id).toBe(tx);
    expect(r.result.foreign).toBeNull();
    expect(r.jits).toEqual(['off', 'off']);
    expect(r.after).toBe('on');
  });

  it('getAllBankTransactionsForExport: jit off, own rows only', async () => {
    const r = await underForcedJit(async () => ({
      own: await getAllBankTransactionsForExport(company, '2026-01-01', '2026-12-31', 10),
      foreign: await getAllBankTransactionsForExport(other, '2026-01-01', '2026-12-31', 10),
    }));
    expect(r.result.own.map((t) => t.id)).toEqual([tx]);
    expect(r.result.foreign).toEqual([]);
    expect(r.jits).toEqual(['off', 'off']);
    expect(r.after).toBe('on');
  });

  it.each([
    ['invoices_null_due_date', invoicesNullDueDate],
    ['invoices_without_revenue_line', invoicesWithoutRevenueLine],
    ['test_records_in_production', testRecordsInProduction],
  ] as const)('integrity check %s: every statement runs with jit off and the request gets jit back', async (id, check) => {
    const r = await underForcedJit(() => check({ companyId: company, asAt: '2026-11-25', limit: 20 }));
    expect(r.result.id).toBe(id);
    expect(r.result.count).toBe(0);
    expect(r.jits.length).toBeGreaterThan(0);
    expect(r.jits.every((j) => j === 'off')).toBe(true);
    expect(r.after).toBe('on');
  });
});
