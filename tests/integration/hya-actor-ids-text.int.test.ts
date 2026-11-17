/**
 * Wave 6 HYa + HYb: the payroll, SARS and tax actor columns (`*_by`) are written with the user id bound as text, never
 * `::uuid` (HYa), and are TEXT (HYb, migration 999w). users.id is varchar: a GoTrue or import id need not be
 * UUID-shaped (`sage-import-bot-…`).
 *
 * Claims, against the disposable fixture (each case runs in a transaction that is always rolled back):
 *  1. Every uuid `*_by` column on the payroll, SARS and tax tables is TEXT, and none is left uuid.
 *  2. Where no pay_run approval rule exists, a non-UUID id creates, prepares and approves a run, saves an EMP201
 *     draft, approves a leave request, writes a UIF declaration and marks it submitted, records an external payslip
 *     import, and is copied from an eFiling event into its submission. Before 999w the column refused it with 22P02.
 *  3. Where the pay_run rule applies (every company's, migration 951), that id is refused as a preparer with 409
 *     PREPARER_ID_NOT_SUPPORTED before any write (coordinator ruling, option a: approval_requests stays uuid until
 *     wave 7), and the header keeps its preparer.
 *  4. A UUID-shaped id still works through the same binds, including a pay run approved through the real route by a
 *     member other than its preparer.
 *  5. approval_document_authors (still uuid[]) names a UUID preparer and fails closed (22P02) on a non-UUID one; it never
 *     drops the preparer from the authors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { createPayrollRun, calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { PreparerIdNotSupportedError } from '@/modules/accounting/services/payroll/payrollPreparerGuard';
import { saveDraftSubmission } from '@/modules/accounting/services/reports/sarsComplianceService';
import { createLeaveRequest, createLeaveType, updateLeaveRequest } from '@/modules/accounting/services/payroll/payrollLeaveService';
import { generateUifDeclaration, markUifSubmitted } from '@/modules/accounting/services/payroll/uifDeclarationService';
import { createExternalImport } from '@/modules/accounting/services/payroll/payrollExternalImportService';
import { applyPollResult, insertEfilingEvent } from '@/modules/accounting/services/reports/sarsEfilingRepo';
import { rig } from './brkr.helpers';

/** Every uuid `*_by` column on the payroll, SARS and tax tables (dev information_schema, 2026-11-17): 999w's list. */
const ACTOR_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['payroll_external_imports', 'created_by'],
  ['payroll_leave_requests', 'approved_by'],
  ['payroll_run_headers', 'approved_by'],
  ['payroll_run_headers', 'cancelled_by'],
  ['payroll_run_headers', 'created_by'],
  ['payroll_run_headers', 'prepared_by'],
  ['sars_efiling_events', 'created_by'],
  ['sars_source_codes', 'imported_by'],
  ['sars_submissions', 'submitted_by'],
  ['tax_directive_payments', 'created_by'],
  ['tax_directives', 'approved_by'],
  ['tax_directives', 'requested_by'],
  ['uif_declarations', 'submitted_by'],
  ['vat_adjustments', 'approved_by'],
  ['vat_adjustments', 'created_by'],
  ['vat_returns', 'submitted_by'],
];

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

/**
 * `fn` as `user`, on one connection inside a transaction that is always rolled back. `noPolicy` first removes the
 * company's pay_run approval rule (951 makes it immutable by trigger, so the triggers are bypassed for that one delete):
 * the state in which no approval is ever raised for a run.
 */
async function rolledBack<T>(user: string, fn: () => Promise<T>, noPolicy = false): Promise<T> {
  const c: PoolClient = await r.pool.connect();
  await c.query('BEGIN');
  try {
    if (noPolicy) {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("DELETE FROM approval_rules WHERE company_id = $1 AND document_type = 'pay_run'", [r.company]);
      await c.query('SET LOCAL session_replication_role = origin');
    }
    return await als.run({ client: c, userId: user, companyId: r.company, claims: { sub: user } } as never, fn);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** The run, prepared, the EMP201 draft, the leave decision, the UIF declaration and the import, all by `user`. */
async function actAs(user: string, month: number, approve = false): Promise<Row> {
  const run = await createPayrollRun(r.company, { month, year: 2026 }, user);
  await calculatePayrollRun(run.id, r.company, user);
  if (approve) await approvePayrollRun(r.company, run.id, user);
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
  // sarsEfilingRepo copies the sending event's created_by into a submission that has no submitted_by (one migration).
  const sent = await saveDraftSubmission(r.company, 'EMP201', `${period}-01`, `${period}-27`, { hya: 'sent' }, user);
  await sql`UPDATE sars_submissions SET submitted_by = NULL WHERE id = ${sent.id}::uuid AND company_id = ${r.company}::uuid`;
  await insertEfilingEvent({ companyId: r.company, submissionId: sent.id, eventType: 'submit', efilingStatus: 'sending', createdBy: user });
  await applyPollResult(r.company, sent.id, { submissionStatus: 'draft', efilingStatus: 'sending', sarsReference: null });
  const [h] = (await sql`SELECT created_by::text AS created_by, prepared_by::text AS prepared_by, approved_by::text AS approved_by
    FROM payroll_run_headers
    WHERE id = ${run.id}::uuid AND company_id = ${r.company}::uuid`) as Row[];
  const client = (als.getStore() as unknown as { client: PoolClient }).client;
  const by = async (table: string, id: string, col: string) =>
    (await client.query(`SELECT ${col}::text AS v FROM ${table} WHERE id = $1 AND company_id = $2`, [id, r.company])).rows[0]?.v;
  return {
    created_by: h!.created_by,
    prepared_by: h!.prepared_by,
    ...(approve ? { approved_by: h!.approved_by } : {}),
    emp201_submitted_by: await by('sars_submissions', draft.id, 'submitted_by'),
    efiling_copied_by: await by('sars_submissions', sent.id, 'submitted_by'),
    leave_approved_by: await by('payroll_leave_requests', leave.id, 'approved_by'),
    uif_generated_by: generatedBy,
    uif_submitted_by: await by('uif_declarations', uif.id, 'submitted_by'),
    import_created_by: await by('payroll_external_imports', imported.id, 'created_by'),
  };
}
const everyColumn = (user: string) => ({
  created_by: user, prepared_by: user, emp201_submitted_by: user, efiling_copied_by: user, leave_approved_by: user,
  uif_generated_by: user, uif_submitted_by: user, import_created_by: user,
});

describe('HYa + HYb: actor ids are bound as text, into TEXT columns', () => {
  it('every actor column on the list is TEXT, and no uuid `*_by` column is left on these tables (999w)', async () => {
    const types = (await r.pool.query(
      `SELECT table_name || '.' || column_name AS col, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND (table_name, column_name) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [ACTOR_COLUMNS.map(([t]) => t), ACTOR_COLUMNS.map(([, c]) => c)])).rows as Array<{ col: string; data_type: string }>;
    expect(types).toHaveLength(ACTOR_COLUMNS.length);
    expect(types.filter((t) => t.data_type !== 'text')).toEqual([]);
    const left = (await r.pool.query(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'uuid' AND column_name LIKE '%\\_by'
          AND table_name ~ '^(payroll|sars|tax|uif|vat)_'`)).rows;
    expect(left).toEqual([]);
  });

  it('with no pay_run approval rule, a non-UUID id prepares and approves a run, saves an EMP201 draft, approves leave, files UIF, imports, and is copied from an eFiling event', async () => {
    expect(await rolledBack(NON_UUID, () => actAs(NON_UUID, 2, true), true))
      .toEqual({ ...everyColumn(NON_UUID), approved_by: NON_UUID });
  }, 90000);

  it('where the pay_run rule applies, a non-UUID preparer is refused with 409 PREPARER_ID_NOT_SUPPORTED before any write', async () => {
    const out = await rolledBack(NON_UUID, async () => {
      const run = await createPayrollRun(r.company, { month: 6, year: 2026 }, r.admin);
      await calculatePayrollRun(run.id, r.company, r.admin);
      const before = ((await sql`SELECT prepared_by::text AS p, approval_revision::text AS v FROM payroll_run_headers
        WHERE id = ${run.id}::uuid AND company_id = ${r.company}::uuid`) as Row[])[0];
      const err = await calculatePayrollRun(run.id, r.company, NON_UUID).then(() => null, (e: unknown) => e);
      const after = ((await sql`SELECT prepared_by::text AS p, approval_revision::text AS v FROM payroll_run_headers
        WHERE id = ${run.id}::uuid AND company_id = ${r.company}::uuid`) as Row[])[0];
      return { err, before, after };
    });
    expect(out.err).toBeInstanceOf(PreparerIdNotSupportedError);
    expect(out.err).toMatchObject({ status: 409, code: 'PREPARER_ID_NOT_SUPPORTED', message: "This account can't prepare pay runs that need approval yet." });
    expect(out.after).toEqual(out.before);
    expect(out.after!.p).toBe(r.admin);
  }, 90000);

  it('a UUID-shaped id works through the same binds', async () => {
    expect(await rolledBack(r.admin, () => actAs(r.admin, 3))).toEqual(everyColumn(r.admin));
  }, 90000);

  it('approval_document_authors names a UUID preparer and fails closed on a non-UUID one (never drops it)', async () => {
    // A non-UUID preparer cannot be recorded under the rule any more (above), so it is written directly.
    const authors = (user: string) => rolledBack(user, async () => {
      const run = await createPayrollRun(r.company, { month: 5, year: 2026 }, r.admin);
      await calculatePayrollRun(run.id, r.company, r.admin);
      await sql`UPDATE payroll_run_headers SET prepared_by = ${user} WHERE id = ${run.id}::uuid AND company_id = ${r.company}::uuid`;
      return ((await sql`SELECT public.approval_document_authors(${r.company}::uuid, 'pay_run', ${run.id}::uuid)::text[] AS a`) as Row[])[0]!.a;
    }).then((a) => a, (e: { code?: string }) => e.code);
    expect(await authors(r.admin)).toEqual([r.admin]);
    expect(await authors(NON_UUID)).toBe('22P02');
  }, 90000);

  it('a non-UUID member executes the approval of a run through the route; the header records preparer and decider', async () => {
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
