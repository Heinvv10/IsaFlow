/**
 * Wave 6 HYa: the payroll, SARS and tax actor columns (`*_by`, uuid on today's schema) are written with the user id
 * bound as text, never `::uuid`, so the code works against both column types. users.id is varchar: a GoTrue or import
 * id need not be UUID-shaped (`sage-import-bot-…`).
 *
 * Three claims, against the disposable fixture:
 *  1. Today's schema: every actor column on the list is uuid, and a non-UUID id is refused there with 22P02. This is the
 *     column refusing it, not the code: HYb (the contract step) changes the columns to TEXT and flips these cases to
 *     expect success.
 *  2. HYb's schema, simulated (the columns altered to TEXT inside a transaction that is always rolled back): the same
 *     non-UUID id creates and prepares a run, saves an EMP201 draft, approves a leave request, writes a UIF declaration
 *     and marks it submitted, and records an external payslip import. A `::uuid` left on any of those binds fails here.
 *  3. A UUID-shaped id still works on today's schema through the same text binds (the old and the new colour both run
 *     on it), including a pay run approved through the real route by a member other than its preparer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createPayrollRun, calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { saveDraftSubmission } from '@/modules/accounting/services/reports/sarsComplianceService';
import { createLeaveRequest, createLeaveType, updateLeaveRequest } from '@/modules/accounting/services/payroll/payrollLeaveService';
import { generateUifDeclaration, markUifSubmitted } from '@/modules/accounting/services/payroll/uifDeclarationService';
import { createExternalImport } from '@/modules/accounting/services/payroll/payrollExternalImportService';
import { rig } from './brkr.helpers';

/** Every uuid `*_by` column on the payroll, SARS and tax tables (dev information_schema, 2026-11-16): HYb's list. */
const ACTOR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['payroll_external_imports', 'created_by'],
  ['payroll_leave_requests', 'approved_by'],
  ['payroll_run_headers', 'approved_by'],
  ['payroll_run_headers', 'cancelled_by'],
  ['payroll_run_headers', 'created_by'],
  ['payroll_run_headers', 'prepared_by'],
  ['sars_efiling_events', 'created_by'],
  ['sars_submissions', 'submitted_by'],
  ['tax_directive_payments', 'created_by'],
  ['tax_directives', 'approved_by'],
  ['tax_directives', 'requested_by'],
  ['uif_declarations', 'submitted_by'],
  ['vat_returns', 'submitted_by'],
];
const TO_TEXT = ACTOR_COLUMNS.map(([t, c]) => `ALTER TABLE public.${t} ALTER COLUMN ${c} TYPE text`).join(';\n');

type Row = Record<string, unknown>;
let r: Awaited<ReturnType<typeof rig>>;
let employeeId: string;
const NON_UUID = `sage-import-bot-hya-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  r = await rig('hya-actor');
  await r.setup();
  employeeId = (await r.employee(30000)).employee;
  await r.pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [NON_UUID, `${NON_UUID}@example.invalid`]);
  await r.pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [r.company, NON_UUID]);
  r.tokens[NON_UUID] = await r.mint(NON_UUID); // teardown deletes every user it holds a token for
}, 60000);
afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
  await r.pool.query('DELETE FROM payroll_leave_requests WHERE company_id = $1', [r.company]);
  await r.pool.query('DELETE FROM payroll_leave_types WHERE company_id = $1', [r.company]);
  await r.teardown();
}, 60000);

/** `fn` as `user`, on one connection inside a transaction that is always rolled back; `text` simulates HYb first. */
async function rolledBack<T>(user: string, text: boolean, fn: () => Promise<T>): Promise<T> {
  const c: PoolClient = await r.pool.connect();
  await c.query('BEGIN');
  try {
    if (text) await c.query(TO_TEXT);
    return await als.run({ client: c, userId: user, companyId: r.company, claims: { sub: user } } as never, fn);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** The run, prepared, the EMP201 draft, the leave decision, the UIF declaration and the import, all by `user`. */
async function actAs(user: string, month: number): Promise<Row> {
  const run = await createPayrollRun(r.company, { month, year: 2026 }, user);
  await calculatePayrollRun(run.id, r.company, user);
  const period = `2026-${String(month).padStart(2, '0')}`;
  const draft = await saveDraftSubmission(r.company, 'EMP201', `${period}-01`, `${period}-28`, { hya: true }, user);
  const type = await createLeaveType(r.company, { name: `HYa ${month}`, bceaType: null, accrualRule: 'none', accrualDays: 0, maxCarryOver: null, isPaid: true } as never);
  const leave = await createLeaveRequest(r.company, { employeeId, leaveTypeId: type.id, startDate: `${period}-05`, endDate: `${period}-05`, days: 1 });
  await updateLeaveRequest(leave.id, r.company, { status: 'approved', approvedBy: user });
  const uif = await generateUifDeclaration(r.company, 2026, month, user);
  const generatedBy = ((await sql`SELECT submitted_by::text AS by FROM uif_declarations
    WHERE id = ${uif.id}::uuid AND company_id = ${r.company}::uuid`) as Row[])[0]!.by;
  await markUifSubmitted(r.company, uif.id, user);
  const imported = await createExternalImport(r.company, {
    periodMonth: month, periodYear: 2026, source: 'hya', fileName: null, componentsPresent: [], rows: [], createdBy: user,
  });
  const [h] = (await sql`SELECT created_by::text AS created_by, prepared_by::text AS prepared_by FROM payroll_run_headers
    WHERE id = ${run.id}::uuid AND company_id = ${r.company}::uuid`) as Row[];
  const client = (als.getStore() as unknown as { client: PoolClient }).client;
  const by = async (table: string, id: string, col: string) =>
    (await client.query(`SELECT ${col}::text AS v FROM ${table} WHERE id = $1 AND company_id = $2`, [id, r.company])).rows[0]?.v;
  return {
    created_by: h!.created_by,
    prepared_by: h!.prepared_by,
    emp201_submitted_by: await by('sars_submissions', draft.id, 'submitted_by'),
    leave_approved_by: await by('payroll_leave_requests', leave.id, 'approved_by'),
    uif_generated_by: generatedBy,
    uif_submitted_by: await by('uif_declarations', uif.id, 'submitted_by'),
    import_created_by: await by('payroll_external_imports', imported.id, 'created_by'),
  };
}
const everyColumn = (user: string) => ({
  created_by: user, prepared_by: user, emp201_submitted_by: user, leave_approved_by: user,
  uif_generated_by: user, uif_submitted_by: user, import_created_by: user,
});

describe('HYa: actor ids are bound as text', () => {
  it('today every actor column on the list is uuid (HYb changes them to text and flips this)', async () => {
    const types = (await r.pool.query(
      `SELECT table_name || '.' || column_name AS col, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND (table_name, column_name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [ACTOR_COLUMNS.map(([t]) => t), ACTOR_COLUMNS.map(([, c]) => c)])).rows as Array<{ col: string; data_type: string }>;
    expect(types).toHaveLength(ACTOR_COLUMNS.length);
    expect(types.filter((t) => t.data_type !== 'uuid')).toEqual([]);
  });

  it('today a non-UUID id is refused with 22P02 by the column: preparing a run, saving an EMP201 draft (HYb flips this)', async () => {
    await expect(rolledBack(NON_UUID, false, () => createPayrollRun(r.company, { month: 1, year: 2026 }, NON_UUID)))
      .rejects.toMatchObject({ code: '22P02' });
    const prepared = await rolledBack(NON_UUID, false, async () => {
      const run = await createPayrollRun(r.company, { month: 1, year: 2026 }, r.admin);
      return calculatePayrollRun(run.id, r.company, NON_UUID).then(() => 'ok', (e: { code?: string }) => e.code);
    });
    expect(prepared).toBe('22P02');
    await expect(rolledBack(NON_UUID, false, () => saveDraftSubmission(r.company, 'EMP201', '2026-01-01', '2026-01-31', {}, NON_UUID)))
      .rejects.toMatchObject({ code: '22P02' });
  }, 60000);

  it("on HYb's schema (TEXT, rolled back) the non-UUID id prepares a run, saves an EMP201 draft and approves leave", async () => {
    expect(await rolledBack(NON_UUID, true, () => actAs(NON_UUID, 2))).toEqual(everyColumn(NON_UUID));
  }, 90000);

  it("a UUID-shaped id works through the same binds on today's schema", async () => {
    expect(await rolledBack(r.admin, false, () => actAs(r.admin, 3))).toEqual(everyColumn(r.admin));
  }, 90000);

  it('a non-UUID member executes the approval of a run through the route today; the header records preparer and decider', async () => {
    const id = await r.calculatedRun(4); // prepared by admin; the approval request decided by the other member
    const planHash = (await r.api.preview(id)).body.data?.planHash;
    expect((await r.api.approveWith(id, planHash, { user: NON_UUID })).statusCode).toBe(200);
    const h = (await r.pool.query('SELECT status, prepared_by::text AS p, approved_by::text AS a FROM payroll_run_headers WHERE id = $1', [id])).rows[0];
    expect(h).toEqual({ status: 'approved', p: r.admin, a: r.approver });
  }, 90000);

  it('the rolled-back cases left nothing behind', async () => {
    const left = (await r.pool.query(
      `SELECT (SELECT count(*) FROM sars_submissions WHERE company_id = $1)::int AS drafts,
              (SELECT count(*) FROM uif_declarations WHERE company_id = $1)::int AS uif,
              (SELECT count(*) FROM payroll_external_imports WHERE company_id = $1)::int AS imports,
              (SELECT count(*) FROM payroll_run_headers WHERE company_id = $1 AND period_month <> 4)::int AS runs`, [r.company])).rows[0];
    expect(left).toEqual({ drafts: 0, uif: 0, imports: 0, runs: 0 });
  });
});
