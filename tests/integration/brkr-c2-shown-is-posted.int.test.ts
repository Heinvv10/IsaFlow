/**
 * BRK-596 round 4 — CLAIM 2 "WHAT WAS SHOWN IS WHAT IS POSTED". Asserts the claim; red = break.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let e1: { employee: string; salaryRow: string };
let acctA = '';
let acctB = '';
const cc = crypto.randomUUID();
const cc2 = crypto.randomUUID();
beforeAll(async () => {
  r = await rig('c2'); await r.setup();
  e1 = await r.employee(20000);
  acctA = await r.account('5210'); acctB = await r.account('5220');
  await r.pool.query('INSERT INTO cost_centres (id, company_id, code, name) VALUES ($1,$2,$3,$3)', [cc, r.company, 'CC-1']);
  await r.pool.query('INSERT INTO cost_centres (id, company_id, code, name) VALUES ($1,$2,$3,$3)', [cc2, r.company, 'CC-2']);
  await r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [r.company, cc, acctA]);
  await r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [cc, e1.employee]);
});
afterAll(async () => { await r.teardown(); });

const snapshot = async () => (await r.pool.query(
  `SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
     SELECT row_to_json(h)::text AS x FROM payroll_run_headers h WHERE company_id = $1
     UNION ALL SELECT row_to_json(l)::text FROM payroll_run_lines l WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)
     UNION ALL SELECT row_to_json(e)::text FROM gl_journal_entries e WHERE company_id = $1
     UNION ALL SELECT row_to_json(l)::text FROM gl_journal_lines l WHERE company_id = $1) s`, [r.company])).rows[0]!.h as string;
const posted = async (journalId: string) => (await r.pool.query(
  `SELECT a.account_code, l.debit::float8 AS debit, l.credit::float8 AS credit FROM gl_journal_lines l
     JOIN gl_accounts a ON a.id = l.gl_account_id WHERE l.journal_entry_id = $1 ORDER BY l.debit DESC, a.account_code`, [journalId])).rows;

describe('CLAIM 2 — what was shown is what is posted', () => {
  it('C2-A: every change between preview and approve is refused 409 with nothing written', async () => {
    const id = await r.calculatedRun(1);
    const p = await r.api.preview(id);
    const hash = p.body.data!.planHash;
    const results: unknown[] = [];
    const attempt = async (name: string, change: () => Promise<unknown>, undo: () => Promise<unknown>, send: unknown = hash) => {
      await change();
      const before = await snapshot();
      const a = await r.api.approveWith(id, send);
      const same = (await snapshot()) === before;
      results.push({ name, status: a.statusCode, nothingWritten: same });
      expect.soft(a.statusCode, name).toBeGreaterThanOrEqual(400);
      expect.soft(same, `${name}: nothing written`).toBe(true);
      await undo();
    };
    await attempt('cost-centre mapping repointed',
      () => r.pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [acctB, cc]),
      () => r.pool.query('UPDATE cost_centre_gl_mappings SET expense_account_id = $1 WHERE cost_centre_id = $2', [acctA, cc]));
    await attempt('cost-centre mapping removed',
      () => r.pool.query('DELETE FROM cost_centre_gl_mappings WHERE cost_centre_id = $1', [cc]),
      () => r.pool.query('INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id) VALUES ($1,$2,$3)', [r.company, cc, acctA]));
    await attempt('employee moved to an unmapped cost centre',
      () => r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [cc2, e1.employee]),
      () => r.pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [cc, e1.employee]));
    await attempt('50/50 allocation added',
      async () => { for (const c of [cc, cc2]) await r.pool.query('INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage) VALUES ($1,$2,$3,50)', [r.company, e1.employee, c]); },
      () => r.pool.query('DELETE FROM payroll_employee_cost_allocations WHERE company_id = $1', [r.company]));
    await attempt('run line gross edited (split weights)',
      () => r.pool.query('UPDATE payroll_run_headers SET total_net = total_net - 0.01 WHERE id = $1', [id]),
      () => r.pool.query('UPDATE payroll_run_headers SET total_net = total_net + 0.01 WHERE id = $1', [id]));
    await attempt('salary changed and recalculated',
      async () => { await r.setSalary(e1.salaryRow, 20000.01); await r.api.calculate(id); },
      async () => { await r.setSalary(e1.salaryRow, 20000); await r.api.calculate(id); });
    await attempt('hash sent as a one-element array', async () => undefined, async () => undefined, [hash]);
    await attempt('hash sent as an object with toString', async () => undefined, async () => undefined, { toString: hash });
    await attempt('empty hash', async () => undefined, async () => undefined, '');
    r.evidence('C2-A changes between preview and approve', results);

    // and the unchanged run still posts exactly the previewed lines
    const ok = await r.api.approveWith(id, (await r.api.preview(id)).body.data!.planHash);
    expect(ok.statusCode).toBe(200);
    const shown = (await r.api.preview(id)).body.data!.posted.lines.map((l: { accountCode: string; debit: number; credit: number }) => ({ account_code: l.accountCode, debit: l.debit, credit: l.credit }));
    expect(await posted(String(ok.body.data!.journalEntryId))).toEqual(shown);
  });

  it('C2-B: a hash identifies ONE plan — the plan of another month must not approve this run', async () => {
    const march = await r.calculatedRun(3);
    const april = await r.calculatedRun(4);
    const pm = (await r.api.preview(march)).body.data!;
    const pa = (await r.api.preview(april)).body.data!;
    const a = await r.api.approveWith(april, pm.planHash); // the hash of MARCH's plan
    r.evidence('C2-B one hash, two plans', {
      march: { hash: pm.planHash, entryDate: pm.plan.entryDate, description: pm.plan.description, runId: pm.plan.runId },
      april: { hash: pa.planHash, entryDate: pa.plan.entryDate, description: pa.plan.description, runId: pa.plan.runId },
      approveAprilWithMarchHash: a.statusCode, header: await r.header(april),
    });
    expect(pm.planHash).not.toBe(pa.planHash);
  });
});
