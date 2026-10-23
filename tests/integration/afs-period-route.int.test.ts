/**
 * GET /api/accounting/afs/[documentId]/period through the real route (withAuth,
 * request transaction): the dates are the financial year's own, a 14-month
 * transition year included; a label a change of year end skipped is a 404, never
 * another year's dates; a document with no usable label falls back to the year
 * holding today; a management pack gets its calendar month. Disposable schema
 * fixture only; synthetic data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { localISODate } from '@/lib/dateUtils';
import route from '../../pages/api/accounting/afs/[documentId]/period';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let u: SetupUser;
let co: string;
const docs: Record<string, string> = {};

type Out = { status: number; body: { data?: { periodStart: string; periodEnd: string }; error?: { message?: string } } };

async function call(documentId: string): Promise<Out> {
  const req = request({ 'sb-access-token': u.token, active_company_id: co }, 'GET') as unknown as
    { url: string; query: Record<string, string> };
  req.url = `/api/accounting/afs/${documentId}/period`;
  req.query = { documentId };
  const out = response();
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as Out['body'] };
}

async function addDoc(key: string, type: 'afs' | 'management_pack', fiscalYear: number | null, period: string | null): Promise<void> {
  docs[key] = (await pool.query(
    `INSERT INTO afs_documents (company_id, fiscal_year, period, document_type, reporting_framework) VALUES ($1, $2, $3, $4, 'ifrs_smes') RETURNING id`,
    [co, fiscalYear, period, type])).rows[0].id;
}

beforeAll(async () => {
  u = await newSetupUser(pool);
  co = u.homeCompanyId;
  await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [co]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: co, userId: u.userId, claims: {} } as never, async () => {
      await generateFiscalYearForDate(co, '2025-05-01');
      await generateFiscalYearForDate(co, '2026-05-01');
      await applyYearEndChange(co, u.userId, { newYearEndMonth: 2, reason: 'Aligned with the holding company', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true }, '2026-10-23');
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
  await addDoc('transition', 'afs', 2026, null);
  await addDoc('skipped', 'afs', 2027, null);
  await addDoc('after', 'afs', 2028, null);
  await addDoc('nolabel', 'afs', null, null);
  await addDoc('pack', 'management_pack', null, '2028-02');
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM afs_documents WHERE company_id = $1', [co]);
    await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [u.userId]);
  } finally { await pool.end(); }
}, 60000);

describe('GET /api/accounting/afs/[documentId]/period', () => {
  it('the 14-month transition year answers its real dates, not January-December', async () => {
    const r = await call(docs.transition!);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.data).toEqual({ periodStart: '2026-01-01', periodEnd: '2027-02-28' });
  });

  it('the year after answers twelve months to the new year end (a leap day included)', async () => {
    const r = await call(docs.after!);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ periodStart: '2027-03-01', periodEnd: '2028-02-29' });
  });

  it('a label the change of year end skipped is a 404 that names it, not some other year', async () => {
    const r = await call(docs.skipped!);
    expect(r.status).toBe(404);
    expect(r.body.error?.message).toContain('2027');
    expect(r.body.data).toBeUndefined();
  });

  it('a document with no usable label falls back to the year holding today', async () => {
    const r = await call(docs.nolabel!);
    expect(r.status).toBe(200);
    const today = localISODate();
    const expected = (await pool.query(
      `SELECT start_date::text AS s, end_date::text AS e FROM public.fiscal_year_for_date($1, $2::date)`, [co, today])).rows[0];
    expect(r.body.data).toEqual({ periodStart: expected.s, periodEnd: expected.e });
    expect(r.body.data!.periodStart <= today && today <= r.body.data!.periodEnd).toBe(true);
  });

  it('a management pack answers its calendar month', async () => {
    const r = await call(docs.pack!);
    expect(r.body.data).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-02-29' });
  });

  it('another company\'s document is a 404', async () => {
    const other = await newSetupUser(pool);
    const stranger = request({ 'sb-access-token': other.token, active_company_id: other.homeCompanyId }, 'GET') as unknown as
      { url: string; query: Record<string, string> };
    stranger.url = '/x';
    stranger.query = { documentId: docs.transition! };
    const out = response();
    await (route as (a: never, b: never) => Promise<unknown>)(stranger as never, out.res as never);
    expect(out.state.statusCode).toBe(404);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [other.userId]);
  });
});
