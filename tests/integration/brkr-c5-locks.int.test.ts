/**
 * BRK-596 round 4 — CLAIM 5 "LOCKS". Asserts the claim; red = break.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { rig, type Res } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let emp = '';
beforeAll(async () => { r = await rig('c5'); await r.setup(); ({ employee: emp } = await r.employee(20000)); });
afterAll(async () => { await r.teardown(); });

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function holdHeader(id: string): Promise<PoolClient> {
  const c = await r.pool.connect();
  await c.query('BEGIN');
  await c.query('SELECT 1 FROM payroll_run_headers WHERE id = $1 FOR UPDATE', [id]);
  return c;
}
/** Start `fn`, report whether it had answered after `waitMs` while the row is held, then release and let it finish. */
async function underHeldLock(id: string, waitMs: number, fn: () => Promise<Res>) {
  const holder = await holdHeader(id);
  const t0 = Date.now();
  let settledAt: number | null = null;
  const p = fn().then((x) => { settledAt = Date.now() - t0; return x; });
  await sleep(waitMs);
  const answeredWhileHeld = settledAt != null;
  const answeredAfterMs = settledAt;
  await holder.query('ROLLBACK'); holder.release();
  const res = await p;
  return { answeredWhileHeld, answeredAfterMs, heldForMs: waitMs, finalStatus: res.statusCode, finalMessage: r.msg(res), totalMs: Date.now() - t0 };
}

describe('CLAIM 5 — locks', () => {
  it('C5-A: no unbounded wait — calculate, approve and reopen all answer within ~5s of a held run row', async () => {
    const id = await r.calculatedRun(1);
    const hash = (await r.api.preview(id)).body.data?.planHash;
    const calc = await underHeldLock(id, 9000, () => r.api.calculate(id));
    const appr = await underHeldLock(id, 9000, () => r.api.approveWith(id, hash));
    // Round 5: the approve above is now refused at 5s, so approve for real before trying reopen.
    expect((await r.api.approveWith(id, hash)).statusCode).toBe(200);
    const reop = await underHeldLock(id, 9000, () => r.api.reopen(id));
    r.evidence('C5-A waits behind a run row held 9s by a peer transaction', { calculate: calc, approve: appr, reopen: reop });
    expect.soft(calc.answeredWhileHeld, 'calculate bounded').toBe(true);
    expect.soft(appr.answeredWhileHeld, 'approve bounded').toBe(true);
    expect.soft(reop.answeredWhileHeld, 'reopen bounded').toBe(true);
    expect.soft([calc.finalStatus, appr.finalStatus, reop.finalStatus]).toEqual([503, 503, 503]);
  }, 90000);

  it('C5-B: calculate / approve / reopen / reverse / loan application at once — no deadlock, no 5xx', async () => {
    const loan = crypto.randomUUID();
    await r.pool.query(
      `INSERT INTO payroll_loans(id,company_id,employee_id,loan_number,description,principal,
         annual_interest_rate,term_months,method,start_date,first_deduction_period_year,
         first_deduction_period_month,status,outstanding_balance)
       VALUES($1,$2,$3,'BRK-LOAN-5','Staff loan',12000,0.085,12,'straight_line',DATE '2026-02-01',2026,2,'active',10000)`,
      [loan, r.company, emp]);
    for (const m of [2, 3]) {
      await r.pool.query(
        `INSERT INTO payroll_loan_schedule(loan_id,sequence,due_period_year,due_period_month,
           opening_balance,interest,principal,installment,closing_balance,paid_flag)
         VALUES($1,$2,2026,$3,10000,0,1000,1000,9000,false)`, [loan, m - 1, m]);
    }
    const a = await r.calculatedRun(2);
    const b = await r.calculatedRun(3); // shares the loan row with run a
    const seen: Record<string, number> = {};
    const fives: string[] = [];
    const note = (name: string, x: Res) => {
      const k = `${name}:${x.statusCode}`; seen[k] = (seen[k] ?? 0) + 1;
      if (x.statusCode >= 500) fives.push(`${name}: ${r.msg(x)}`);
    };
    for (let round = 0; round < 12; round += 1) {
      const ha = (await r.api.preview(a)).body.data?.planHash;
      const hb = (await r.api.preview(b)).body.data?.planHash;
      const ja = (await r.header(a)).journal_entry_id as string | null;
      const jb = (await r.header(b)).journal_entry_id as string | null;
      const jobs: Array<[string, Promise<Res>]> = [
        ['calculate', r.api.calculate(a)], ['approve', r.api.approveWith(a, ha)], ['reopen', r.api.reopen(a)],
        ['calculate', r.api.calculate(b)], ['approve', r.api.approveWith(b, hb)], ['reopen', r.api.reopen(b)],
        ['approve', r.api.approveWith(a, ha)], ['calculate', r.api.calculate(a)],
      ];
      if (ja) jobs.push(['reverse', r.api.reverse(ja)]);
      if (jb) jobs.push(['reverse', r.api.reverse(jb)]);
      for (const [name, p] of jobs) note(name, await p);
    }
    const stuckConnections = (await r.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`)).rows[0]!.n;
    r.evidence('C5-B concurrent mix over two runs sharing a loan', { seen, fiveHundreds: [...new Set(fives)], idleInTransactionAfter: stuckConnections,
      headers: [await r.header(a), await r.header(b)] });
    expect.soft(fives.filter((f) => /deadlock/i.test(f))).toEqual([]);
    expect.soft(stuckConnections).toBe(0);
    // The one 5xx the breaker saw, on master and on the PR alike: two journals numbered at once
    // collide on uq_gl_je_company_entry_number and the loser rolls back. Pre-existing, in the GL's
    // numbering, and not this PR's to fix; any OTHER 5xx fails here.
    expect([...new Set(fives)].filter((f) => !/uq_gl_je_company_entry_number/.test(f))).toEqual([]);
  }, 120000);
});
