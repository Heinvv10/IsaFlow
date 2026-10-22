/**
 * The financial year start is locked once a company has posted a journal, and
 * before that a change rebuilds the periods so they follow it.
 *
 * resolveCompanyPeriodAlignment builds every new year on the layout of the
 * EXISTING periods, so an edit of financial_year_start that left the periods
 * alone silently changed nothing in the books: the declared year and the real
 * one drifted apart. PUT /api/accounting/companies (the one writer of the
 * column after creation) now refuses a change after the first posting with a
 * 409, and before it rebuilds the periods in the same transaction. A save of the
 * SAME month is a no-op, even over periods that start in another month.
 *
 * Disposable schema fixture only (assertDisposable). The real withAuth runs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { financialYearFixture } from './helpers/financialYearFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = financialYearFixture(pool);
const { onboarded, put, getCompany, stored, journal, makeCalendarPeriods } = fx;

afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 60000);

const COMING_SOON = /guided change of year end \(coming soon\).*contact support/;

describe('PUT /api/accounting/companies: financialYearStart', () => {
  it('before any posting, a change is saved and the periods are rebuilt on the new month', async () => {
    const { u, companyId } = await onboarded();
    expect((await getCompany(u, companyId)).body.data).toMatchObject({
      financialYearStartLocked: false, financialYearStartLockReason: null, financialYearStartActual: 3,
    });

    const out = await put(u, { id: companyId, financialYearStart: 6 });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(companyId)).toMatchObject({ fy: 6, first_month: 6, periods: 12 });
  });

  it('after a posted journal, a change is refused with a 409 and nothing is written', async () => {
    const { u, companyId } = await onboarded();
    await journal(companyId, u.userId, 'posted');
    const before = await stored(companyId);
    expect((await getCompany(u, companyId)).body.data).toMatchObject({
      financialYearStartLocked: true, financialYearStartLockReason: 'posted',
    });

    const out = await put(u, { id: companyId, financialYearStart: 9, tradingName: 'must not land' });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error?.message).toMatch(/after the first posting/);
    expect(out.body.error?.message).toMatch(COMING_SOON);
    expect(await stored(companyId)).toEqual(before);
  });

  it('after a posted journal, re-sending the SAME start month (a normal settings save) still saves', async () => {
    const { u, companyId } = await onboarded();
    await journal(companyId, u.userId, 'posted');
    const out = await put(u, { id: companyId, financialYearStart: 3, tradingName: 'Saved Trading' });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(companyId)).toMatchObject({ fy: 3, trading_name: 'Saved Trading', first_month: 3 });
  });

  it.each([[null], [0]])('a stored %s start month means March: saving 3 with postings is a normal save, not a 409', async (raw) => {
    const { u, companyId } = await onboarded();
    await journal(companyId, u.userId, 'posted');
    await pool.query('UPDATE companies SET financial_year_start = $2 WHERE id = $1', [companyId, raw]);
    const out = await put(u, { id: companyId, financialYearStart: 3, tradingName: 'Normalised' });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(companyId)).toMatchObject({ trading_name: 'Normalised', first_month: 3, periods: 12 });
  });

  it('with only a draft journal, a change is refused with a 409 (its period is in use) and nothing is written', async () => {
    const { u, companyId } = await onboarded();
    await journal(companyId, u.userId, 'draft');
    const before = await stored(companyId);
    expect((await getCompany(u, companyId)).body.data!.financialYearStartLocked).toBe(false);

    const out = await put(u, { id: companyId, financialYearStart: 9 });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error?.message).toMatch(/draft journals/);
    expect(out.body.error?.message).toMatch(COMING_SOON);
    expect(await stored(companyId)).toEqual(before);
  });

  it('refuses when a period is no longer open: a closed period is never recreated as open', async () => {
    const { u, companyId } = await onboarded();
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND period_number = 1`, [companyId]);
    const before = await stored(companyId);
    const out = await put(u, { id: companyId, financialYearStart: 6 });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error?.message).toMatch(/nonOpenPeriods: 1/);
    expect(await stored(companyId)).toEqual(before);
  });

  it.each([
    ['accounting_budgets', `INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year) VALUES ($1, 'probe', 2027)`],
    ['afs_documents', `INSERT INTO afs_documents (company_id, document_type, reporting_framework, fiscal_year)
                       VALUES ($1, 'afs', 'ifrs_smes', 2027)`],
    ['disclosure_notes_manual', `INSERT INTO disclosure_notes_manual (company_id, fiscal_year, note_number, title, content, created_by)
                                 SELECT $1, 2027, 99, 'probe', 'probe', user_id FROM company_users WHERE company_id = $1 LIMIT 1`],
  ])('refuses when %s holds rows keyed by fiscal-year number', async (_table, insert) => {
    const { u, companyId } = await onboarded();
    await pool.query(insert, [companyId]);
    const before = await stored(companyId);
    const out = await put(u, { id: companyId, financialYearStart: 6 });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(await stored(companyId)).toEqual(before);
  });

  it('refuses a start month that is not a month', async () => {
    const { u, companyId } = await onboarded();
    const out = await put(u, { id: companyId, financialYearStart: 13 });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect((await stored(companyId)).fy).toBe(3);
  });

  it('refuses a change to a company other than the active one, and GET marks it not editable there', async () => {
    const { u, companyId, homeCompanyId } = await onboarded();
    const asHome = { ...u, homeCompanyId };
    const out = await put(asHome, { id: companyId, financialYearStart: 6 });
    expect(out.status, JSON.stringify(out.body)).toBe(400);
    expect(await stored(companyId)).toMatchObject({ fy: 3, first_month: 3 });
    // Counted under the ACTIVE company's RLS, a lock flag for another company could be wrong: it is not computed.
    expect((await getCompany(asHome, companyId)).body.data).toMatchObject({
      financialYearStartLocked: true, financialYearStartLockReason: 'not_active', financialYearStartActual: null,
    });
  });
});

describe('the same month never touches the periods, even when they start in another month', () => {
  // Existing companies are not realigned by a routine save (Hein, 2026-10-22): the settings page PUTs the
  // whole company, financialYearStart included, so a "repair" here would rebuild periods on every save.
  it('unused calendar periods on a March company stay as they are after a plain save', async () => {
    const { u, companyId } = await onboarded();
    await makeCalendarPeriods(companyId);
    expect((await getCompany(u, companyId)).body.data).toMatchObject({ financialYearStart: 3, financialYearStartActual: 1 });
    const before = (await pool.query(
      `SELECT id, start_date::text FROM fiscal_periods WHERE company_id = $1 ORDER BY start_date`, [companyId])).rows;

    const out = await put(u, { id: companyId, financialYearStart: 3, tradingName: 'No realign' });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await stored(companyId)).toMatchObject({ fy: 3, trading_name: 'No realign', first_month: 1, periods: 12 });
    expect((await pool.query(
      `SELECT id, start_date::text FROM fiscal_periods WHERE company_id = $1 ORDER BY start_date`, [companyId])).rows)
      .toEqual(before);
  });
});
