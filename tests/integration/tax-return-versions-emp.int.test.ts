/**
 * EMP201 finalise through the real route (wave 5 L1a). The return is refused (409) unless every
 * pay run of the period is final under R-035 (assertPayRunApproved), never by status string:
 * an `approved` run with no reviewed plan is a DRAFT payslip, and the status-string selector in
 * generateEMP201 would still sum it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  callRoute, count, dropReturnFixture, loginAsToken, seedReturnFixture, type ReturnFixture,
} from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import versions from '../../pages/api/accounting/sars/returns/[form]/versions';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;

const lastDay = (m: number) => new Date(Date.UTC(2026, m, 0)).getUTCDate();
const pad = (m: number) => String(m).padStart(2, '0');
/** One calendar month of 2026. */
const month = (m: number) => ({ periodStart: `2026-${pad(m)}-01`, periodEnd: `2026-${pad(m)}-${lastDay(m)}` });
let rf: ReturnFixture;
const c = () => rf.fx.companyId;
const post = (token: string, m: number) => callRoute(finalise, c(), token, 'POST', { form: 'emp201' }, month(m));
const postRaw = (body: Record<string, unknown>) => callRoute(finalise, c(), rf.admin.token, 'POST', { form: 'emp201' }, body);
const getV = (m: number) => callRoute(versions, c(), rf.admin.token, 'GET', { form: 'emp201', ...month(m) });
type Drift = { drifted: boolean; fields: { name: string }[]; changed: string[]; unfinalRuns: number };
const driftOf = async (m: number) =>
  ((await getV(m)).body as { data: { versions: { drift: Drift }[] } }).data.versions[0]!.drift;

/**
 * A run. `final` = `approved` with an approval time (FS: COALESCE(approved_at, approval_grandfathered_at) is not null).
 * Otherwise an `approved` row with neither column is a DRAFT payslip, as an approval that never completed leaves it.
 */
async function run(m: number, status: string, final: boolean, paye: number): Promise<string> {
  return String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye,
      total_uif, total_sdl, total_eti, employee_count, approved_at)
    VALUES (${c()}::UUID, 2026, ${m}, ${status}, 50000, ${paye}, 500, 500, 0, 1,
      ${final ? '2026-03-31T10:00:00Z' : null}::TIMESTAMPTZ)
    RETURNING id`) as Row[])[0]!.id);
}

describeIfDb('EMP201 finalise, against real pay runs', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company with pay run headers and return versions.');
    rf = await seedReturnFixture('RVE', DATABASE_URL!);
  }, 240000);
  afterAll(async () => { if (rf) await dropReturnFixture(rf); }, 120000);

  it('an approved run with no reviewed plan (a DRAFT payslip): 409, no version', async () => {
    await run(1, 'approved', false, 9000);
    const r = await post(rf.admin.token, 1);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/01\/2026/);
    expect(await count('tax_return_versions', c())).toBe(0);
  });

  it('a calculated run of the period (not summed, not final): 409, no version', async () => {
    await run(2, 'calculated', false, 0);
    expect((await post(rf.admin.token, 2)).status).toBe(409);
    expect(await count('tax_return_versions', c())).toBe(0);
  });

  it('a cancelled run is excluded from the gate: the month finalises as a nil return', async () => {
    await run(4, 'cancelled', false, 777);
    const r = await post(rf.admin.token, 4);
    expect(r.status).toBe(200);
    expect((r.body as { data: { version: Row } }).data.version.figures).toMatchObject({ totalPAYE: 0, runs: [] });
  });

  it('a month with no runs at all finalises as a nil return (SARS requires one), posted_through = now', async () => {
    const r = await post(rf.admin.token, 8);
    expect(r.status).toBe(200);
    const v = (r.body as { data: { version: Row } }).data.version;
    expect(v.figures).toMatchObject({ totalPAYE: 0, runs: [] });
    expect(Math.abs(Date.now() - new Date(String(v.postedThrough)).getTime())).toBeLessThan(60_000);
  });

  it('only a whole ended calendar month: anything else is 400, nothing written', async () => {
    const before = await count('tax_return_versions', c());
    for (const p of [
      { periodStart: '2026-10-02', periodEnd: '2026-10-31' }, // not the 1st
      { periodStart: '2026-02-01', periodEnd: '2026-02-27' }, // not the last day (28th)
      { periodStart: '2026-01-01', periodEnd: '2026-12-31' }, // a whole year
      { periodStart: '2026-09-01', periodEnd: '2026-10-31' }, // two months
      { periodStart: '2026-11-01', periodEnd: '2026-11-30' }, // the current month has not ended
      { periodStart: '2027-01-01', periodEnd: '2027-01-31' }, // the future
      { periodStart: '2026-02-01', periodEnd: '2026-02-31' }, // not a date
    ]) expect((await postRaw(p)).status).toBe(400);
    expect(await count('tax_return_versions', c())).toBe(before);
  });

  it('a month ending on its last day (28 Feb, 31 Jan) is accepted', async () => {
    await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c()}::UUID AND period_month IN (1, 2)`;
    expect((await post(rf.admin.token, 1)).status).toBe(200);
    expect((await post(rf.admin.token, 2)).status).toBe(200);
  });

  it('Login-as is refused: 403, nothing written', async () => {
    await run(3, 'approved', true, 4000);
    const n = await count('tax_return_versions', c());
    expect((await post(await loginAsToken(rf), 3)).status).toBe(403);
    expect(await count('tax_return_versions', c())).toBe(n);
  });

  it('a viewer cannot finalise: 403', async () => {
    const n = await count('tax_return_versions', c());
    expect((await post(rf.viewer.token, 3)).status).toBe(403);
    expect(await count('tax_return_versions', c())).toBe(n);
  });

  it('every run final: 200, figures from the runs, run ids and posted_through = latest approved_at, no payroll lock', async () => {
    const r = await post(rf.admin.token, 3);
    expect(r.status).toBe(200);
    const v = (r.body as { data: { version: Row } }).data.version;
    expect(v).toMatchObject({ versionNo: 1, status: 'finalised', vatPeriodLockId: null, finalisedBy: rf.admin.userId });
    expect(v.figures).toMatchObject({ totalPAYE: 4000, totalSDL: 500, totalUIF: 500 });
    expect((v.figures as { runs: Row[] }).runs).toHaveLength(1);
    expect(new Date(String(v.postedThrough)).toISOString()).toBe('2026-03-31T10:00:00.000Z');
    expect(await count('vat_period_locks', c())).toBe(0);
    expect((await post(rf.admin.token, 3)).status).toBe(409); // already finalised
  });

  it('drift: no drift at first; a changed figure, a changed plan hash and a reopened run each show', async () => {
    expect(await driftOf(3)).toEqual({ drifted: false, fields: [], changed: [], unfinalRuns: 0 });
    await sql`UPDATE payroll_run_headers SET total_paye = 5000 WHERE company_id = ${c()}::UUID AND period_month = 3`;
    const figure = await driftOf(3);
    expect(figure.drifted).toBe(true);
    expect(figure.fields.map((f) => f.name)).toContain('totalPAYE');
    await sql`UPDATE payroll_run_headers SET total_paye = 4000, approved_plan_hash = 'changed'
      WHERE company_id = ${c()}::UUID AND period_month = 3`;
    expect((await driftOf(3)).changed).toEqual(['runs']);
    await sql`UPDATE payroll_run_headers SET approved_at = NULL, approval_grandfathered_at = NULL
      WHERE company_id = ${c()}::UUID AND period_month = 3`;
    expect((await driftOf(3)).unfinalRuns).toBe(1);
  });

  it('directive payments: stored as totals only, never per-person rows', async () => {
    const v = ((await getV(3)).body as { data: { versions: { figures: Row }[] } }).data.versions[0]!.figures;
    expect(v.directivePayments).toEqual([]);
    expect(v.directiveTotals).toEqual({ count: 0, gross: 0, paye: 0 });
  });

  it('company B asks for company A\'s months and sees nothing', async () => {
    const b = await seedReturnFixture('RVE2', DATABASE_URL!);
    try {
      const r = await callRoute(versions, b.fx.companyId, b.admin.token, 'GET', { form: 'emp201', ...month(3) });
      expect((r.body as { data: { versions: Row[] } }).data.versions).toEqual([]);
    } finally {
      await dropReturnFixture(b);
    }
  });
});
