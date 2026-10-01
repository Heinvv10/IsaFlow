/**
 * BRK-596 round 4 — CLAIM 5, last clause: "a caller outside a request transaction (the scripts that
 * call the services directly) is not worse off than before". calculatePayrollRun and
 * approvePayrollRun called directly, as scripts/seed-payroll-lines-apr-dec.ts and
 * scripts/simulate-fy2026-workflows.ts do, with the approve landing while the calculate runs.
 * Asserts: whatever the outcome, the run's lines, its header and its journal agree.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
const rows: string[] = [];
beforeAll(async () => {
  r = await rig('c5d'); await r.setup();
  for (let i = 0; i < 40; i += 1) rows.push((await r.employee(10000)).salaryRow);
}, 60000);
afterAll(async () => { await r.teardown(); });
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe('CLAIM 5 — a script caller (no request transaction)', () => {
  it('C5-D: approve landing during a direct calculate leaves lines, header and journal in agreement', async () => {
    const results: unknown[] = [];
    let inconsistent = 0;
    for (const [month, delay] of [[1, 20], [2, 60], [3, 120], [4, 200]] as const) {
      const id = await r.calculatedRun(month);
      await r.pool.query('UPDATE payroll_employee_components SET amount = 12000 WHERE id = ANY($1)', [rows]);
      // Round 5: as the two scripts now call them — each inside withAlsTransaction, so the run's
      // header lock holds for the whole calculation. Called bare (as they were), the approve landed
      // mid-calculation and left header, lines and journal disagreeing.
      const actor = { companyId: r.company, userId: r.admin };
      const calc = withAlsTransaction(actor, () => calculatePayrollRun(id, r.company)).then(() => 'ok', (e: Error) => `THREW: ${e.message}`);
      await sleep(delay);
      const appr = withAlsTransaction(actor, () => approvePayrollRun(r.company, id, r.admin)).then((x) => `ok journal ${x.journalEntryId}`, (e: Error) => `THREW: ${e.message}`);
      const [c, a] = await Promise.all([calc, appr]);
      const h = await r.header(id);
      const lines = Number((await r.pool.query('SELECT sum(gross_pay)::float8 AS g FROM payroll_run_lines WHERE run_id = $1', [id])).rows[0]!.g);
      const journalGrossSide = h.journal_entry_id == null ? null : Number((await r.pool.query(
        `SELECT sum(credit)::float8 AS c FROM gl_journal_lines l JOIN gl_accounts a ON a.id = l.gl_account_id
          WHERE l.journal_entry_id = $1 AND a.account_code = '1110'`, [h.journal_entry_id])).rows[0]!.c);
      const row = { month, approveFiredAfterMs: delay, calculate: c, approve: a, status: h.status, headerGross: h.gross, runLinesGross: lines,
        headerNet: h.net, journalNetPay: journalGrossSide };
      results.push(row);
      if (h.gross !== lines || (h.status === 'approved' && journalGrossSide !== h.net)) inconsistent += 1;
      await r.pool.query('UPDATE payroll_employee_components SET amount = 10000 WHERE id = ANY($1)', [rows]);
    }
    r.evidence('C5-D direct service calls: approve during calculate', results);
    expect(inconsistent).toBe(0);
  }, 120000);
});
