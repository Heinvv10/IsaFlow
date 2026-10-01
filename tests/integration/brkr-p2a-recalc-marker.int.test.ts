/**
 * BRK-596 pass 2 (on 3768f0828), P2-A and its control, ported in W3-01 round 6 — the
 * "recalculated since posting" marker. Each test asserts the claim; red = break.
 *
 * Only these two of the pass-2 delta repros are ported: the others (P2-B…P2-E) HELD on
 * 3768f0828 and are covered by the brkr-c* suites and the w3-01 files.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { runRecalculatedSince } from '@/modules/accounting/services/payroll/payrollJournalChain';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let e1: { employee: string; salaryRow: string };
let acctA = ''; let acctB = '';
const cc = crypto.randomUUID();
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
beforeAll(async () => {
  r = await rig('p2new'); await r.setup(); e1 = await r.employee(20000);
  acctA = await r.account('5210'); acctB = await r.account('5220');
  await r.pool.query('INSERT INTO cost_centres (id, company_id, code, name) VALUES ($1,$2,$3,$3)', [cc, r.company, 'CC-1']);
  await r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [r.company, cc, acctA]);
  await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [cc, e1.employee]);
});
afterAll(async () => { await r.teardown(); });

describe('PASS 2 — the delta', () => {
  it('P2-A: a run never recalculated after posting is not flagged "recalculated" (approve overlapping a no-change calculate)', async () => {
    const id = await r.calculatedRun(1);
    const hash = (await r.api.preview(id)).body.data!.planHash;
    // The approve request opens first and waits for the run row; a calculate (same figures) gets the row before it.
    const holder: PoolClient = await r.pool.connect();
    await holder.query('BEGIN'); await holder.query('SELECT 1 FROM payroll_run_headers WHERE id = $1 FOR UPDATE', [id]);
    const calc = r.api.calculate(id); await sleep(300);
    const appr = r.api.approveWith(id, hash); await sleep(1500);
    await holder.query('ROLLBACK'); holder.release();
    const [c, a] = await Promise.all([calc, appr]);
    const j1 = String(a.body.data?.journalEntryId);
    const times = (await r.pool.query(
      `SELECT e.created_at AS journal_created, (SELECT max(created_at) FROM payroll_run_lines WHERE run_id = $2) AS lines_created FROM gl_journal_entries e WHERE e.id = $1`, [j1, id])).rows[0];
    await r.api.reopen(id);
    // Not recalculated since. The pinned, legitimate case: the cost-centre mapping is repointed — "not the run changing".
    await r.pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [acctB, cc]);
    const p = await r.api.preview(id);
    const again = await r.api.approveWith(id, p.body.data?.planHash);
    r.evidence('P2-A recalculated marker, approve overlapping a calculate', { calculate: c.statusCode, approve: a.statusCode, times,
      afterReopenAndMappingChange: { blocker: p.body.data?.blocker?.code, reapprove: again.statusCode, message: r.msg(again)?.slice(0, 160) } });
    await r.pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [acctA, cc]);
    expect(a.statusCode).toBe(200);
    expect(p.body.data?.blocker ?? null).toBeNull();
  }, 30000);

  it('P2-A2 (control): same walk without the overlap re-locks', async () => {
    const id = await r.calculatedRun(2);
    await r.api.approve(id); await r.api.reopen(id);
    await r.pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [acctB, cc]);
    const p = await r.api.preview(id);
    r.evidence('P2-A2 control', { blocker: p.body.data?.blocker?.code ?? null });
    await r.pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [acctA, cc]);
    expect(p.body.data?.blocker ?? null).toBeNull();
  });

  // Round 6: the other side of the same marker — after an overlapped approval, a REAL
  // recalculation (reopen, then calculate) is still seen.
  it('P2-A3: after an approve that overlapped a calculate, a later recalculation IS flagged', async () => {
    const id = await r.calculatedRun(3);
    const hash = (await r.api.preview(id)).body.data!.planHash;
    const holder: PoolClient = await r.pool.connect();
    await holder.query('BEGIN'); await holder.query('SELECT 1 FROM payroll_run_headers WHERE id = $1 FOR UPDATE', [id]);
    const calc = r.api.calculate(id); await sleep(300);
    const appr = r.api.approveWith(id, hash); await sleep(1500);
    await holder.query('ROLLBACK'); holder.release();
    const [, a] = await Promise.all([calc, appr]);
    expect(a.statusCode).toBe(200);
    const journal = String(a.body.data!.journalEntryId);
    expect(await runRecalculatedSince(r.company, id, journal)).toBe(false);

    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect(await runRecalculatedSince(r.company, id, journal)).toBe(false); // reopening is not recalculating
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect(await runRecalculatedSince(r.company, id, journal)).toBe(true);
  }, 30000);
});
