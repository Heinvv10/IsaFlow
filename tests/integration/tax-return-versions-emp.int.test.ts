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

const pad = (m: number) => String(m).padStart(2, '0');
const month = (m: number, to = m) => ({ periodStart: `2026-${pad(m)}-01`, periodEnd: `2026-${pad(to)}-28` });
let rf: ReturnFixture;
const c = () => rf.fx.companyId;
const post = (token: string, m: number, to = m) =>
  callRoute(finalise, c(), token, 'POST', { form: 'emp201' }, month(m, to));

/** A run. `final` = grandfathered under 951 (R-035 final). Otherwise approved with no reviewed plan. */
async function run(m: number, status: string, final: boolean, paye: number): Promise<string> {
  return String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye,
      total_uif, total_sdl, total_eti, employee_count, approved_at, approval_grandfathered_at)
    VALUES (${c()}::UUID, 2026, ${m}, ${status}, 50000, ${paye}, 500, 500, 0, 1,
      ${status === 'approved' ? '2026-03-31T10:00:00Z' : null}::TIMESTAMPTZ,
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

  it('a final run alongside a calculated one in the same period: 409, no version', async () => {
    await run(4, 'approved', true, 4000);
    await run(5, 'calculated', false, 0);
    expect((await post(rf.admin.token, 4, 5)).status).toBe(409);
    expect(await count('tax_return_versions', c())).toBe(0);
  });

  it('Login-as is refused: 403, nothing written', async () => {
    await run(3, 'approved', true, 4000);
    expect((await post(await loginAsToken(rf), 3)).status).toBe(403);
    expect(await count('tax_return_versions', c())).toBe(0);
  });

  it('a viewer cannot finalise: 403', async () => {
    expect((await post(rf.viewer.token, 3)).status).toBe(403);
    expect(await count('tax_return_versions', c())).toBe(0);
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

  it('drift: a run added to the period afterwards shows as drift on the live version', async () => {
    await run(6, 'approved', true, 4000);
    expect((await post(rf.admin.token, 6, 7)).status).toBe(200);
    const before = await callRoute(versions, c(), rf.admin.token, 'GET', { form: 'emp201', ...month(6, 7) });
    expect((before.body as { data: { versions: Row[] } }).data.versions[0]!.drift).toEqual({ drifted: false, fields: [] });
    await run(7, 'approved', true, 1000);
    const after = await callRoute(versions, c(), rf.admin.token, 'GET', { form: 'emp201', ...month(6, 7) });
    const drift = (after.body as { data: { versions: { drift: { drifted: boolean; fields: { name: string }[] } }[] } }).data.versions[0]!.drift;
    expect(drift.drifted).toBe(true);
    expect(drift.fields.map((f) => f.name)).toContain('totalPAYE');
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
