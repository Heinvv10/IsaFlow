/**
 * The SARS calendar completes an item IsaFlow filed, from the company's own sars_submissions, through
 * the real route (withAuth, app_user, RLS):
 *   - a 'submitted' EMP201 for December (due January next year) and an 'accepted' one show "Filed on
 *     eFiling" with the reference; draft and rejected rows do not;
 *   - one monthly VAT201 of a bi-monthly period does not; the second month completes it;
 *   - company B never sees A's filings;
 *   - a filing is shown over a manual mark (no mark id exposed);
 *   - a failed submissions read sets submissionsUnavailable and leaves the transaction usable.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import calendarRoute from '../../pages/api/accounting/sars/sars-compliance';
import filedRoute from '../../pages/api/accounting/sars/compliance-filed';
import { als } from '@/lib/als';
import { getComplianceCalendarWithMarks } from '@/modules/accounting/services/reports/sarsComplianceCalendarDb';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetsRouteFixture } from './helpers/budgetsRouteFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const calendar = budgetsRouteFixture(pool, calendarRoute, '/api/accounting/sars/sars-compliance');
const filed = budgetsRouteFixture(pool, filedRoute, '/api/accounting/sars/compliance-filed');
const Y = new Date().getFullYear();
let a: SetupUser, b: SetupUser;

type Ev = Record<string, unknown>;
async function get(u: SetupUser): Promise<{ events: Ev[]; submissionsUnavailable: unknown }> {
  const out = await calendar.call(u, 'GET');
  expect(out.status).toBe(200);
  return { events: (out.body.data?.events ?? []) as Ev[], submissionsUnavailable: out.body.data?.submissionsUnavailable };
}
const item = async (u: SetupUser, type: string, periodEnd: string) =>
  (await get(u)).events.find((e) => e.eventType === type && e.periodEnd === periodEnd);
const submit = (co: string, form: string, start: string, end: string, status: string, ref: string | null = null) => pool.query(
  `INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
   VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'draft' THEN NULL ELSE now() END)`, [co, form, start, end, status, ref]);

beforeAll(async () => {
  a = (await calendar.owner()).u;
  b = (await calendar.owner()).u;
  for (const u of [a, b]) {
    await pool.query(`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'even', vat_system_type = 'invoice' WHERE id = $1`, [u.homeCompanyId]);
  }
}, 60_000);
afterAll(async () => {
  try {
    for (const u of [a, b]) {
      for (const t of ['sars_submissions', 'sars_compliance_events', 'audit_log']) await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [u.homeCompanyId]);
    }
    await calendar.cleanup();
    await filed.cleanup();
  } finally { await pool.end(); }
});

describe('EMP201', () => {
  it('a submitted December EMP201 (due next January): Filed on eFiling with its reference', async () => {
    await submit(a.homeCompanyId, 'EMP201', `${Y}-12-01`, `${Y}-12-31`, 'submitted', 'EF-DEC');
    expect(await item(a, 'EMP201_DUE', `${Y}-12-31`)).toMatchObject({ status: 'completed', efiling: { reference: 'EF-DEC' } });
  });

  it('an accepted EMP201 completes its month', async () => {
    await submit(a.homeCompanyId, 'EMP201', `${Y}-01-01`, `${Y}-01-31`, 'accepted', 'EF-JAN');
    expect((await item(a, 'EMP201_DUE', `${Y}-01-31`))?.status).toBe('completed');
  });

  it.each(['draft', 'rejected', 'superseded'])('a %s EMP201 does not', async (status) => {
    const month = { draft: '03', rejected: '04', superseded: '05' }[status]!;
    const end = `${Y}-${month}-${new Date(Date.UTC(Y, Number(month), 0)).getUTCDate()}`;
    await submit(a.homeCompanyId, 'EMP201', `${Y}-${month}-01`, end, status);
    const e = await item(a, 'EMP201_DUE', end);
    expect(e?.efiling).toBeUndefined();
    expect(e?.status).not.toBe('completed');
  });

  it("company B never sees A's filings", async () => {
    expect((await item(b, 'EMP201_DUE', `${Y}-12-31`))?.efiling).toBeUndefined();
  });
});

describe('VAT201 (Cat B, bi-monthly)', () => {
  it('one month of the Jan–Feb period does not complete it; the other month does', async () => {
    const febEnd = `${Y}-02-${new Date(Date.UTC(Y, 2, 0)).getUTCDate()}`;
    await submit(a.homeCompanyId, 'VAT201', `${Y}-02-01`, febEnd, 'submitted');
    expect((await item(a, 'VAT201_DUE', febEnd))?.efiling).toBeUndefined();
    await submit(a.homeCompanyId, 'VAT201', `${Y}-01-01`, `${Y}-01-31`, 'submitted', 'EF-V1');
    expect((await item(a, 'VAT201_DUE', febEnd))?.status).toBe('completed');
  });
});

describe('a filing and a manual mark on one item', () => {
  it('the filing is shown and the mark is not exposed', async () => {
    const end = `${Y}-06-30`;
    expect((await filed.call(a, 'POST', { eventType: 'EMP201_DUE', periodEnd: end })).status).toBe(201);
    expect((await item(a, 'EMP201_DUE', end))?.id).toBeTruthy();
    await submit(a.homeCompanyId, 'EMP201', `${Y}-06-01`, end, 'submitted', 'EF-JUN');
    const e = await item(a, 'EMP201_DUE', end);
    expect(e).toMatchObject({ status: 'completed', efiling: { reference: 'EF-JUN' } });
    expect(e?.id).toBeUndefined();
  });
});

describe('a failed submissions read', () => {
  it('sets submissionsUnavailable, keeps the calendar, and the next statement in the tx still runs', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Rolled back with the transaction: app_user loses SELECT on sars_submissions only inside this test's tx.
      await client.query('REVOKE SELECT ON sars_submissions FROM app_user');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: a.userId })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [a.homeCompanyId]);
      const out = await als.run({ client, userId: a.userId, companyId: a.homeCompanyId, claims: { sub: a.userId } } as never,
        () => getComplianceCalendarWithMarks(a.homeCompanyId, Y));
      expect(out.submissionsUnavailable).toBe(true);
      expect(out.marksUnavailable).toBe(false);
      expect(out.events.length).toBeGreaterThan(10);
      expect((await client.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('a successful read: submissionsUnavailable false', async () => {
    expect((await get(a)).submissionsUnavailable).toBe(false);
  });
});
