/**
 * Wave 7 EL (W25, W26): a regular pay run whose month's EMP201 is filed is not reopened (Hein ruling 3, 2026-11-25),
 * and the EMP201 filing's lock order against the reopen and the off-cycle create.
 *
 *  - W25: the reopen is refused (409 EMP201_FILED) naming the EMP201 (its PRN; a finalised version by number; a
 *    legacy submission by its reference), before any write: the header and the audit trail are unchanged.
 *  - W26: a filing and a reopen in flight together both finish (no deadlock, no lock timeout), and the filing no
 *    longer takes the company's filing-reference key before the month's draft key: the off-cycle create takes them
 *    the other way round (payrollOffCycleRun lockMonthFilings: draft, then PRN), which made a deadlock.
 * Real routes and services on a fixture company (two months apart per case); real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { amendV, c, genFile, PRN, row, useFixture, versionOf } from './helpers/returnFileCalls';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import file from '../../pages/api/accounting/sars/returns/[form]/file';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let rf: ReturnFixture;

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const per = (y: number, m: number) => ({
  periodStart: `${y}-${String(m).padStart(2, '0')}-01`, periodEnd: `${y}-${String(m).padStart(2, '0')}-${lastDay(y, m)}`,
});

/** An approved regular run (header only: the reopen judges and writes the header). */
async function approvedRun(y: number, m: number, extra: { freq?: string; start?: string; end?: string; runDate?: string } = {}): Promise<string> {
  const rows = (await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye,
      total_uif, total_sdl, total_eti, employee_count, approved_at, approved_by, pay_frequency, period_start, period_end, run_date)
    VALUES (${c()}::UUID, ${y}, ${m}, 'approved', 50000, 9000, 500, 500, 0, 1, ${`${per(y, m).periodEnd}T10:00:00Z`}, ${rf.admin.userId},
      ${extra.freq ?? 'monthly'}, ${extra.start ?? per(y, m).periodStart}::DATE, ${extra.end ?? per(y, m).periodEnd}::DATE,
      ${extra.runDate ?? null}::DATE)
    RETURNING id`) as Row[];
  return String(rows[0]!.id);
}

const finaliseMonth = async (y: number, m: number) => {
  const r = await callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' }, per(y, m));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(versionOf(r).id);
};
const fileVersion = async (id: string, n: number) => {
  await genFile(id, 'emp201');
  return callRoute(file, c(), rf.admin.token, 'POST', { form: 'emp201' }, { versionId: id, reference: PRN('emp201', n) });
};
const reopen = (runId: string) => inTx(rf.fx, () => reopenPayrollRun({ runId, companyId: c(), userId: rf.admin.userId, reason: 'w7 el reopen' }));
const header = async (id: string) => ((await sql`SELECT * FROM payroll_run_headers WHERE id = ${id}::UUID`) as Row[])[0]!;
const auditCount = async () =>
  Number(((await sql`SELECT COUNT(*)::INT AS n FROM audit_log WHERE company_id = ${c()}::UUID`) as Row[])[0]!.n);
const legacyRow = async (y: number, m: number, reference: string | null) => {
  await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference)
    VALUES (${c()}::UUID, 'EMP201', ${per(y, m).periodStart}::DATE, ${per(y, m).periodEnd}::DATE, 'submitted', ${reference})`;
};

/** Refused before any write: the header and the audit trail are exactly as before. */
async function expectRefused(runId: string, pattern: RegExp): Promise<void> {
  const before = await header(runId);
  const audits = await auditCount();
  const err = await reopen(runId).then(() => null, (e: unknown) => e as Error & { code?: string; status?: number });
  expect(err, 'the reopen was refused').not.toBeNull();
  expect(err!.code).toBe('EMP201_FILED');
  expect(err!.status).toBe(409);
  expect(err!.message).toMatch(pattern);
  expect(await header(runId)).toEqual(before);
  expect(await auditCount()).toBe(audits);
}

describeIfDb('W25: a regular run whose month\'s EMP201 is filed is not reopened', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, pay runs, submissions and return versions.');
    rf = await seedReturnFixture('W7EL', DATABASE_URL!);
    useFixture(rf);
  }, 240000);
  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
  }, 120000);

  it('filed: 409 EMP201_FILED naming the PRN, nothing written; a month whose EMP201 is not filed reopens', async () => {
    const filedRun = await approvedRun(2025, 9);
    const v = await finaliseMonth(2025, 9);
    expect((await fileVersion(v, 701)).status).toBe(200);
    await expectRefused(filedRun, new RegExp(`EMP201 for 2025-09 is filed \\(reference ${PRN('emp201', 701)}\\)`));

    const openRun = await approvedRun(2025, 10);
    await reopen(openRun);
    expect((await header(openRun)).status).toBe('calculated');
  });

  it('finalised, not filed: refused naming the version; once amended, the run reopens', async () => {
    const run = await approvedRun(2025, 7);
    const v = await finaliseMonth(2025, 7);
    await expectRefused(run, /EMP201 for 2025-07 is finalised as version 1 \(not filed yet\)\. Amend that EMP201 version first/);
    expect((await amendV(v, { reason: 'W7 EL: correct a payslip' }, rf.admin.token, 'emp201')).status).toBe(200);
    await reopen(run);
    expect((await header(run)).status).toBe('calculated');
  });

  it('a legacy submitted EMP201: refused naming its reference (or that none was recorded)', async () => {
    const run = await approvedRun(2025, 5);
    await legacyRow(2025, 5, 'LEGACY-EL-5');
    await expectRefused(run, /EMP201 for 2025-05 was submitted outside the return lifecycle \(reference LEGACY-EL-5\)/);
    const bare = await approvedRun(2025, 3);
    await legacyRow(2025, 3, null);
    await expectRefused(bare, /EMP201 for 2025-03 was submitted outside the return lifecycle \(no reference recorded\)/);
  });

  it('a weekly run straddling two months is judged on its pay date\'s month, not the month its period starts in', async () => {
    // Paid Friday 2026-01-02 for 27 Dec to 2 Jan: declared in January (payrollFrequencyGuard keeps period month = pay month).
    const run = await approvedRun(2026, 1, { freq: 'weekly', start: '2025-12-27', end: '2026-01-02', runDate: '2026-01-02' });
    await legacyRow(2025, 12, 'LEGACY-EL-DEC');
    await reopen(run); // December's EMP201 is filed, January's is not
    expect((await header(run)).status).toBe('calculated');
    await sql`UPDATE payroll_run_headers SET status = 'approved', approved_at = now() WHERE id = ${run}::UUID`;
    await legacyRow(2026, 1, 'LEGACY-EL-JAN');
    await expectRefused(run, /EMP201 for 2026-01 was submitted outside the return lifecycle \(reference LEGACY-EL-JAN\)/);
  });

  it('a monthly run paid early in the next month: refused when the pay date\'s month is filed', async () => {
    const run = await approvedRun(2024, 11, { runDate: '2024-12-02' });
    await legacyRow(2024, 12, 'LEGACY-EL-PAID-DEC');
    await expectRefused(run, /EMP201 for 2024-12 was submitted outside the return lifecycle \(reference LEGACY-EL-PAID-DEC\)/);
  });
});

/** Polls until another backend waits on a lock (an advisory key or a row), at most ~10 s. */
async function untilSomeoneWaits(): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const w = (await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' LIMIT 1`) as Row[];
    if (w.length > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no backend ever waited on a lock');
}

describeIfDb('W26: the EMP201 filing\'s lock order', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, pay runs, submissions and return versions.');
    rf = await seedReturnFixture('W7EL2', DATABASE_URL!);
    useFixture(rf);
  }, 240000);
  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
  }, 120000);

  it('a filing and a reopen of the month, released together, both finish: the filing is recorded, the reopen refused', async () => {
    const run = await approvedRun(2025, 8);
    const v = await finaliseMonth(2025, 8);
    await genFile(v, 'emp201');
    const holder = await rf.fx.pool.connect();
    try {
      // An approval in flight holds the company's payroll approval lock: the filing and the reopen both queue on it.
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_approval:${c()}`]);
      const t0 = Date.now();
      const filing = callRoute(file, c(), rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v, reference: PRN('emp201', 801) });
      const reopening = reopen(run).then(() => null, (e: unknown) => e as Error & { code?: string });
      await untilSomeoneWaits();
      await holder.query('COMMIT');
      const [f, r] = await Promise.all([filing, reopening]);
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(f.status, JSON.stringify(f.body)).toBe(200);
      expect(r?.code).toBe('EMP201_FILED'); // whichever went first, the month's EMP201 was final when the reopen judged it
      expect((await row(v)).status).toBe('filed');
      expect((await header(run)).status).toBe('approved');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('an off-cycle create\'s keys (the month\'s draft key, then the filing-reference key) beside a filing: no deadlock', async () => {
    const v = await finaliseMonth(2025, 6); // a nil month: no run to be final
    await genFile(v, 'emp201');
    const { periodStart, periodEnd } = per(2025, 6);
    const offCycle = await rf.fx.pool.connect();
    try {
      // createOffCycleRun's first two statements (payrollOffCycleRun lockMonthFilings), the keys spelled as it spells them.
      await offCycle.query('BEGIN');
      await offCycle.query("SET LOCAL lock_timeout = '8s'");
      await offCycle.query(`SELECT pg_advisory_xact_lock(hashtextextended('sars-draft:' || $1::uuid::text || ':EMP201:'
        || make_date($2::int, $3::int, 1)::text || ':' || (make_date($2::int, $3::int, 1) + INTERVAL '1 month - 1 day')::date::text, 0))`,
      [c(), 2025, 6]);
      expect(periodStart).toBe('2025-06-01');
      expect(periodEnd).toBe('2025-06-30');
      const filing = callRoute(file, c(), rf.admin.token, 'POST', { form: 'emp201' }, { versionId: v, reference: PRN('emp201', 802) });
      await untilSomeoneWaits(); // the filing waits on the month's draft key the off-cycle create holds
      // The off-cycle create's second key. Before W26 the filing already held it and waited on the draft key: 40P01.
      await offCycle.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`efa-prn:${c()}`]);
      await offCycle.query('COMMIT');
      const f = await filing;
      expect(f.status, JSON.stringify(f.body)).toBe(200);
      expect((await row(v)).status).toBe('filed');
    } finally {
      await offCycle.query('ROLLBACK').catch(() => undefined);
      offCycle.release();
    }
  });
});
