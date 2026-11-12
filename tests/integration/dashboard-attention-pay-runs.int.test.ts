/**
 * The dashboard's "Needs attention" list and open pay runs (app audit
 * 12 Nov 2026, P2.5 item 5): rows are anchored on the current period, not on
 * whatever run was left open first.
 *
 * Company C has cash of 1 000 and four open runs: January 2020 (forgotten, and
 * carrying totals of 50 000, far above cash), this month (a draft with no
 * totals yet), the month before (approved, 400, which cash covers) and two
 * years ahead. Company D has a run of its own this month. So:
 *   - only this month's and last month's runs are rows of their own;
 *   - the 2020 run is summarised as "1 older pay run still open";
 *   - no "Cash is short" row: an unbounded read of the next run would pick
 *     the 2020 run and report a 49 000 shortfall for it;
 *   - nothing from D, nothing for the run two years ahead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { fixtureWriters } from './kpi-one-source.helpers';
import { todayInSast } from '@/lib/saDateParser';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import attentionRoute from '../../pages/api/accounting/dashboard/attention';
import type { AttentionList } from '@/modules/accounting/services/dashboard/attentionShape';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const id = (): string => crypto.randomUUID();
const USER = id();
const C = id();
const D = id();
const A = { bank: id(), capital: id() };
const RUN = { old: id(), now: id(), prev: id(), future: id(), other: id() };
const T = todayInSast();
const [T_YEAR, T_MONTH] = [Number(T.slice(0, 4)), Number(T.slice(5, 7))];
const [P_YEAR, P_MONTH] = T_MONTH === 1 ? [T_YEAR - 1, 12] : [T_YEAR, T_MONTH - 1];
const MONTH_NAME = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const add = (n: number): string => {
  const d = new Date(`${T}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const { journal } = fixtureWriters(pool, USER, add);
let token = '';

async function cleanup(): Promise<void> {
  const cos = [C, D];
  await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1::uuid[]))', [cos]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM company_users WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [cos]);
  await pool.query('DELETE FROM users WHERE id = $1', [USER]);
}

describeIfDb('dashboard attention list: pay runs anchored on the current period', () => {
  beforeAll(async () => {
    assertDisposable();
    await cleanup();
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [USER, `attn-${USER}@test.local`]);
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [C, 'Attention pay runs', D, 'Attention other tenant']);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$3,'admin'),($2,$3,'admin')", [C, D, USER]);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
       VALUES($1,$3,'1000','Bank','asset','bank','debit',true,false),($2,$3,'3000','Capital','equity','share_capital','credit',true,false)`,
      [A.bank, A.capital, C]);
    clearSystemAccountCache(C);
    await journal(C, add(-5), A.bank, A.capital, 1000);
    await pool.query(
      `INSERT INTO payroll_run_headers(id,company_id,period_year,period_month,status,total_net,total_paye)
       VALUES($1,$6,2020,1,'approved',40000,10000),
             ($2,$6,$8,$9,'draft',0,0),
             ($3,$6,$10,$11,'approved',300,100),
             ($4,$6,$12,$9,'calculated',0,0),
             ($5,$7,$8,$9,'draft',0,0)`,
      [RUN.old, RUN.now, RUN.prev, RUN.future, RUN.other, C, D, T_YEAR, T_MONTH, P_YEAR, P_MONTH, T_YEAR + 2]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }, 120000);

  afterAll(async () => {
    try {
      clearSystemAccountCache(C);
      await cleanup();
    } finally {
      await pool.end();
    }
  }, 60000);

  it('one row per current-window run, the 2020 run summarised, no shortfall for it, nothing ahead or from D', async () => {
    const req = request({ 'sb-access-token': token, active_company_id: C }, 'GET');
    (req as unknown as { query: unknown }).query = {};
    const result = response();
    await (attentionRoute as unknown as (a: unknown, b: unknown) => Promise<void>)(req, result.res);
    expect(result.state.statusCode).toBe(200);
    const data = (result.state.body as { data: AttentionList }).data;

    const runRows = data.items.filter((i) => i.key.startsWith('pay-run-'));
    expect(runRows.map((i) => i.key).sort()).toEqual([`pay-run-${RUN.now}`, `pay-run-${RUN.prev}`].sort());
    expect(runRows.find((i) => i.key === `pay-run-${RUN.now}`)).toMatchObject({
      label: `${MONTH_NAME[T_MONTH - 1]} ${T_YEAR} pay run`, detail: 'Draft', href: `/payroll/runs/${RUN.now}`,
    });
    expect(data.items.find((i) => i.key === 'pay-runs-older')).toMatchObject({ label: '1 older pay run still open', detail: 'Oldest: January 2020' });

    expect(data.items.find((i) => i.key === 'payroll-shortfall')).toBeUndefined();
    expect(data.items.some((i) => i.label.startsWith('Cash is short'))).toBe(false);

    expect(data.items.some((i) => i.label === `${MONTH_NAME[T_MONTH - 1]} ${T_YEAR + 2} pay run`)).toBe(false);
    const all = JSON.stringify(data.items);
    expect(all).not.toContain(RUN.future);
    expect(all).not.toContain(RUN.other);
    expect(all).not.toContain(RUN.old);
    expect(new Set(data.items.map((i) => i.key)).size).toBe(data.items.length);
  });
});
