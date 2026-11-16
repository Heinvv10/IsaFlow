/**
 * The SARS calendar completes an item IsaFlow filed, from the company's own sars_submissions, through
 * the real route (withAuth, app_user, RLS):
 *   - how it was filed: an ISV row SARS accepted is `efiled`, an ISV row still 'submitted' is
 *     `processing`, a row with no channel (a user recorded it) is `recorded` with who; draft,
 *     rejected and superseded rows never complete an item; a December EMP201 is due next January;
 *   - one monthly VAT201 of a bi-monthly period does not complete it; the second month does; a
 *     bi-monthly VAT201 never completes a monthly item;
 *   - company B never sees A's filings;
 *   - a filing is shown over a manual mark, which stays exposed (so it can be undone);
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
const submit = (co: string, form: string, start: string, end: string, status: string, ref: string | null = null,
  opts: { isv?: boolean; by?: string } = {}) => pool.query(
  `INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at,
                                 efiling_channel, efiling_correlation_id, submitted_by)
   VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'draft' THEN NULL ELSE now() END, $7, $8, $9::UUID)`,
  [co, form, start, end, status, ref, opts.isv ? 'isv' : null, opts.isv ? `corr-${crypto.randomUUID()}` : null, opts.by ?? null]);

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
  it('a December EMP201 a user recorded (due next January): recorded, with who and the reference', async () => {
    await submit(a.homeCompanyId, 'EMP201', `${Y}-12-01`, `${Y}-12-31`, 'submitted', 'EF-DEC', { by: a.userId });
    const dec = await item(a, 'EMP201_DUE', `${Y}-12-31`);
    expect(String(dec?.dueDate).slice(0, 4)).toBe(String(Y + 1));
    expect(dec).toMatchObject({ status: 'completed', efiling: { kind: 'recorded', filings: [{ reference: 'EF-DEC' }] } });
    expect((dec?.efiling as { filings: Array<{ by: unknown }> }).filings[0]!.by).toBeTruthy();
  });

  it('an ISV EMP201 SARS accepted: efiled', async () => {
    await submit(a.homeCompanyId, 'EMP201', `${Y}-01-01`, `${Y}-01-31`, 'accepted', 'EF-JAN', { isv: true });
    expect(await item(a, 'EMP201_DUE', `${Y}-01-31`)).toMatchObject({ status: 'completed', efiling: { kind: 'efiled' } });
  });

  it('an ISV EMP201 SARS has not ruled on: processing', async () => {
    await submit(a.homeCompanyId, 'EMP201', `${Y}-02-01`, `${Y}-02-${new Date(Date.UTC(Y, 2, 0)).getUTCDate()}`, 'submitted', null, { isv: true });
    expect((await item(a, 'EMP201_DUE', `${Y}-02-${new Date(Date.UTC(Y, 2, 0)).getUTCDate()}`))?.efiling).toMatchObject({ kind: 'processing' });
  });

  it.each(['draft', 'rejected', 'superseded'])('a %s EMP201 does not complete its month', async (status) => {
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

describe('a monthly VAT item and a bi-monthly filing', () => {
  it('a VAT201 for Jan–Feb never completes the monthly January item', async () => {
    await pool.query(`UPDATE companies SET vat_period = 'monthly', vat_period_alignment = 'even', vat_system_type = 'invoice' WHERE id = $1`, [b.homeCompanyId]);
    try {
      const febEnd = `${Y}-02-${new Date(Date.UTC(Y, 2, 0)).getUTCDate()}`;
      await submit(b.homeCompanyId, 'VAT201', `${Y}-01-01`, febEnd, 'submitted', 'BI');
      const jan = await item(b, 'VAT201_DUE', `${Y}-01-31`);
      expect(jan?.periodStart).toBe(`${Y}-01-01`);
      expect(jan?.efiling).toBeUndefined();
      expect((await item(b, 'VAT201_DUE', febEnd))?.efiling).toBeUndefined();
    } finally {
      await pool.query(`UPDATE companies SET vat_period = 'bi-monthly' WHERE id = $1`, [b.homeCompanyId]);
      await pool.query('DELETE FROM sars_submissions WHERE company_id = $1', [b.homeCompanyId]);
    }
  });
});

describe('a filing and a manual mark on one item', () => {
  it('the filing is shown and the mark stays exposed', async () => {
    const end = `${Y}-06-30`;
    expect((await filed.call(a, 'POST', { eventType: 'EMP201_DUE', periodEnd: end })).status).toBe(201);
    expect((await item(a, 'EMP201_DUE', end))?.id).toBeTruthy();
    await submit(a.homeCompanyId, 'EMP201', `${Y}-06-01`, end, 'submitted', 'EF-JUN');
    const e = await item(a, 'EMP201_DUE', end);
    expect(e).toMatchObject({ status: 'completed', efiling: { kind: 'recorded', filings: [{ reference: 'EF-JUN' }] } });
    expect(e?.id).toBeTruthy();
    expect((await filed.call(a, 'DELETE', { eventType: 'EMP201_DUE', periodEnd: end })).status).toBe(200);
    const after = await item(a, 'EMP201_DUE', end);
    expect(after?.id).toBeUndefined();
    expect(after?.efiling).toBeTruthy();
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
