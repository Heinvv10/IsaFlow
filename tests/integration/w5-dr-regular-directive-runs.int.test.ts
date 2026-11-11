/**
 * Wave 5 DR: a run under an IRP3(b)/(c) directive (real routes and SQL). Each describe owns its company.
 *
 * - the loader: in force on the judge date (the run's pay date, else the period end), its boundaries, a partial month,
 *   the first month after it ended, two in force; tenancy;
 * - a run applies it (20% of R20 000 = R4 000), the month leaves the year to date, approval refuses a run whose
 *   directive changed or that two directives tax;
 * - once a run is approved: cancel 409 (set an expiry date instead), delete 409, expiry shortened only and never before
 *   that run, a retroactive directive refused; the lump-sum readers refuse or ignore it; EMP201 and the certificate
 *   read the stored line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  applyStandalone, approveRun, calculateRun, cleanSeveranceFixtures, codes, createRunFor, previewRun, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { deleteDirective, drFixture, insertDirective, patchDirective, PCT, postDirective } from './w5-dr.helpers';
import { loadRegularPayDirectives, regularDirectiveLatestUse, regularDirectiveRefusal } from '@/modules/accounting/services/payroll/payrollRunRegularDirective';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { listRunLumpSums } from '@/modules/accounting/services/payroll/payrollLumpSumFiling';
import { listRegularDirectiveNumbers } from '@/modules/accounting/services/payroll/easyFileRegularDirectives';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const made: SeveranceFixture[] = [];
const fixture = async (name: string) => { const f = await drFixture(pool, name); made.push(f); return f; };
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, made); } finally { await pool.end(); }
});
const load = async (f: SeveranceFixture, month: number, runId: string | null = null) =>
  (await loadRegularPayDirectives(f.company, [f.employee], { year: 2026, month }, runId)).get(f.employee);

describe('the loader: in force on the judge date', () => {
  let f: SeveranceFixture;
  let other: SeveranceFixture;
  beforeAll(async () => { f = await fixture('DR loader'); other = await fixture('DR loader other'); });

  it('boundaries: effective on the last day applies; expiry on the last day applies; expiry the day before does not, and warns', async () => {
    const onLast = await insertDirective(pool, f.company, f.employee, { effective: '2026-03-31', expiry: '2026-04-30' });
    expect((await load(f, 3))?.current?.id).toBe(onLast);
    expect((await load(f, 4))?.current?.id).toBe(onLast);
    const april = await load(f, 4);
    expect(april?.partial).toEqual([]);
    await pool.query("UPDATE tax_directives SET expiry_date = '2026-04-29' WHERE id = $1", [onLast]);
    const short = await load(f, 4);
    expect(short?.current ?? null).toBeNull();
    expect(short?.partial.map(p => [p.directive.id, p.applied])).toEqual([[onLast, false]]);
    expect(short?.ended?.id).toBe(onLast);
  });

  it('a 03-15 expiry: not in force on 31 March, warned as partial, and ended (it was in force on 28 February)', async () => {
    await pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [f.company]);
    const id = await insertDirective(pool, f.company, f.employee, { effective: '2026-02-01', expiry: '2026-03-15' });
    const march = await load(f, 3);
    expect([march?.current ?? null, march?.ended?.id, march?.partial.map(p => p.applied)]).toEqual([null, id, [false]]);
  });

  it('06-20 to 06-25: neither in force on 30 June nor silent', async () => {
    await pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [f.company]);
    const id = await insertDirective(pool, f.company, f.employee, { effective: '2026-06-20', expiry: '2026-06-25' });
    const june = await load(f, 6);
    expect([june?.current ?? null, june?.partial.map(p => [p.directive.id, p.applied])]).toEqual([null, [[id, false]]]);
  });

  it('the run\'s pay date judges: a 06-25 pay date takes the 06-20 to 06-25 window (applied, still warned)', async () => {
    const run = await createRunFor(f, 6);
    await pool.query("UPDATE payroll_run_headers SET run_date = '2026-06-25' WHERE id = $1", [run]);
    const june = await load(f, 6, run);
    expect(june?.current?.effectiveDate).toBe('2026-06-20');
    expect(june?.partial.map(p => p.applied)).toEqual([true]);
  });

  it('two in force: none current, both named; an unusable row is invalid', async () => {
    await pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [f.company]);
    await insertDirective(pool, f.company, f.employee, { number: '111' });
    await insertDirective(pool, f.company, f.employee, { number: '222', effective: '2026-05-01' });
    const may = await load(f, 5);
    expect([may?.current ?? null, [...(may?.overlapping ?? [])].sort()]).toEqual([null, ['111', '222']]);
    await pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [f.company]);
    await insertDirective(pool, f.company, f.employee, { number: '333', rate: 0 });
    expect((await load(f, 5))?.invalid).toEqual(['333']);
  });

  it('another company\'s approved directive naming this employee never applies', async () => {
    await pool.query("UPDATE tax_directives SET status = 'cancelled' WHERE company_id = $1", [f.company]);
    await insertDirective(pool, other.company, f.employee);
    expect((await load(f, 3))?.current ?? null).toBeNull();
  });
});

describe('a run under a 20% directive, then approved', () => {
  let f: SeveranceFixture;
  let directiveId = '';
  let march = '';
  beforeAll(async () => {
    f = await fixture('DR run');
    directiveId = String((await postDirective(f, PCT)).body.data!.id);
    await patchDirective(f, directiveId, { status: 'approved' });
    march = await createRunFor(f, 3);
    await calculateRun(f, march);
  });

  it('20% of the R20 000 base = R4 000, flagged off the tables with the base named', async () => {
    const line = await runLine(pool, march, f.employee);
    expect(line.paye).toBe(4000);
    const result = (line.validation_results as Array<{ code: string; treatment?: string; message: string; directive?: { id: string } }>)
      .find(v => v.code === 'PAYE_OUTSIDE_TABLES');
    expect([result?.treatment, result?.directive?.id]).toEqual(['directive', directiveId]);
    expect(result?.message).toMatch(/20% of R.20.000\.00 remuneration before deductions/);
  });

  it('approved: the month is out of April\'s year to date; EMP201 and the certificate read the stored line', async () => {
    expect((await approveRun(f, march)).statusCode).toBe(200);
    const ytd = await loadPayeYearToDate(f.company, crypto.randomUUID(), { year: 2026, month: 4 }, [f.employee]);
    expect([ytd.get(f.employee)?.periods ?? 0, ytd.get(f.employee)?.tablePaye ?? 0]).toEqual([0, 0]);
    // The directive's live row changes (written straight, as no route may): the filed figures do not.
    await pool.query("UPDATE tax_directives SET status = 'cancelled', directive_number = '0000000' WHERE id = $1", [directiveId]);
    expect((await generateEMP201(f.company, '2026-03-01', '2026-03-31')).payePayable).toBe(4000);
    expect((await listRegularDirectiveNumbers(f.company, { start: '2026-03-01', end: '2027-02-28' })).get(f.employee)).toEqual(['1234567']);
    await pool.query("UPDATE tax_directives SET status = 'approved', directive_number = '1234567' WHERE id = $1", [directiveId]);
  });

  it('cancel: 409, set an expiry date instead; delete: 409', async () => {
    const cancel = await patchDirective(f, directiveId, { status: 'cancelled' });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.body.error?.message).toMatch(/set an expiry date instead/);
    expect((await deleteDirective(f, directiveId)).statusCode).toBe(409);
  });

  it('expiry: later than its window 400, before the March run 400, empty 400; shortened to 03-31 it is', async () => {
    expect((await patchDirective(f, directiveId, { expiry_date: '2027-03-31' })).statusCode).toBe(400);
    expect((await patchDirective(f, directiveId, { expiry_date: '2026-03-30' })).statusCode).toBe(400);
    expect((await patchDirective(f, directiveId, { expiry_date: '' })).statusCode).toBe(400);
    const ok = await patchDirective(f, directiveId, { expiry_date: '2026-03-31' });
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
  });

  it('April after the shortening: the tables, DIRECTIVE_ENDED; a run calculated before it is refused regular_directive_changed', async () => {
    await pool.query("UPDATE tax_directives SET expiry_date = NULL WHERE id = $1", [directiveId]);
    const april = await createRunFor(f, 4);
    await calculateRun(f, april);
    expect((await runLine(pool, april, f.employee)).paye).toBe(4000);
    expect((await patchDirective(f, directiveId, { expiry_date: '2026-03-31' })).statusCode).toBe(200);
    expect((await previewRun(f, april)).body.data?.blocker?.code).toBe('regular_directive_changed');
    await calculateRun(f, april);
    const line = await runLine(pool, april, f.employee);
    expect(codes(line.validation_results)).toEqual(expect.arrayContaining(['DIRECTIVE_ENDED']));
    expect(codes(line.validation_results)).not.toContain('PAYE_OUTSIDE_TABLES');
  });

  it('lump-sum readers: the stand-alone payment 400 (no payment row); run filing ignores a breakdown item naming it', async () => {
    const r = await applyStandalone(f, directiveId);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect((await pool.query('SELECT count(*)::int AS n FROM tax_directive_payments WHERE tax_directive_id = $1', [directiveId])).rows[0]!.n).toBe(0);
    await pool.query(
      'UPDATE payroll_run_lines SET component_breakdown = component_breakdown || $3::jsonb WHERE run_id = $1 AND employee_id = $2',
      [march, f.employee, JSON.stringify([{ componentId: 'forged', sarsSourceCode: '3901', amount: 1000, isTaxable: true, directive: { id: directiveId, paye: 200 } }])]);
    expect((await listRunLumpSums(f.company, { start: '2026-03-01', end: '2027-02-28' }, f.employee)).get(f.employee) ?? []).toEqual([]);
  });

  it('tenancy: another company reads no use, and its gate finds no line, of this company\'s run', async () => {
    const other = await fixture('DR run other');
    expect(await regularDirectiveLatestUse(other.company, directiveId)).toBeNull();
    expect(await regularDirectiveRefusal(other.company, march)).toBeNull();
  });
});

describe('the gate\'s overlap branch', () => {
  it('two approved rows in force (written straight): the line errors, approval refuses regular_directive_overlap', async () => {
    const f = await fixture('DR gate overlap');
    await insertDirective(pool, f.company, f.employee, { number: '111' });
    await insertDirective(pool, f.company, f.employee, { number: '222', effective: '2026-05-01' });
    const run = await createRunFor(f, 5);
    await calculateRun(f, run);
    expect(codes((await runLine(pool, run, f.employee)).validation_results)).toContain('DIRECTIVE_OVERLAP');
    expect((await previewRun(f, run)).body.data?.blocker?.code).toBe('regular_directive_overlap');
  });
});

describe('only a draft run used it: delete allowed (the 409\'s counter-case)', () => {
  it('approved, a draft run taxed by it, deleted: 200', async () => {
    const f = await fixture('DR draft only');
    const id = String((await postDirective(f, PCT)).body.data!.id);
    await patchDirective(f, id, { status: 'approved' });
    const run = await createRunFor(f, 3);
    await calculateRun(f, run);
    expect((await runLine(pool, run, f.employee)).paye).toBe(4000);
    expect(await regularDirectiveLatestUse(f.company, id)).toBeNull();
    expect((await deleteDirective(f, id)).statusCode).toBe(200);
  });
});

describe('a directive over a period already approved (retroactive): refused at create and at approve', () => {
  it('pending before March was approved, then approving it: 400; a new one over March: 400', async () => {
    const f = await fixture('DR retroactive');
    const pending = String((await postDirective(f, PCT)).body.data!.id);
    const run = await createRunFor(f, 3);
    await calculateRun(f, run);
    expect((await approveRun(f, run)).statusCode).toBe(200);
    const approve = await patchDirective(f, pending, { status: 'approved' });
    expect(approve.statusCode).toBe(400);
    expect(approve.body.error?.message).toMatch(/2026-03 payroll run .*already approved/);
    await patchDirective(f, pending, { status: 'cancelled' });
    const created = await postDirective(f, { ...PCT, directive_number: '8888888' });
    expect(created.statusCode).toBe(400);
    expect(created.body.error?.message).toMatch(/2026-03 payroll run .*already approved/);
    const fromApril = await postDirective(f, { ...PCT, effective_date: '2026-04-01', directive_number: '9999999' });
    expect(fromApril.statusCode, JSON.stringify(fromApril.body)).toBe(201);
  });
});
