/**
 * getReportingPeriod's branches on real PostgreSQL, and the narrow lookup the
 * exports and disclosure notes use (findReportingPeriod). One company with a
 * hand-built chain of years:
 *   FY2019  2019-01-01..2019-12-31   12 months
 *   FY2020  2020-01-01..2020-06-30    6 months, no change record
 *   FY2021  2020-07-01..2021-08-31   14 months, a change record whose reason ends in a full stop
 *   FY2022  2021-09-01..2022-08-31   12 months, its comparative is the 14-month year
 * and a company that declares no start month and has no years at all.
 * All data synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { getReportingPeriod, findReportingPeriod } from '@/modules/accounting/services/afs/afsReportingPeriod';
import { StartMonthAssumedError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const co = crypto.randomUUID(), bare = crypto.randomUUID(), user = crypto.randomUUID();

async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: user, claims: {} } as never, fn);
    await client.query('ROLLBACK');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function addYear(label: number, start: string, end: string, kind = 'normal'): Promise<string> {
  return (await pool.query(
    `INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [co, label, start, end, kind])).rows[0].id;
}

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYPB co', 1)`, [co]);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYPB bare', NULL)`, [bare]);
  await addYear(2019, '2019-01-01', '2019-12-31');
  await addYear(2020, '2020-01-01', '2020-06-30');
  // The change record is bound to the year as it stood (to 2021-06-30); the year is then extended to the 14 months.
  const transition = await addYear(2021, '2020-07-01', '2021-06-30', 'transition');
  const change = (await pool.query(
    `INSERT INTO fiscal_year_end_changes (company_id, fiscal_year_id, from_start_month, to_start_month, transition_start, from_end_date,
       to_end_date, months, reason, cipc_filed_confirmed, sars_notified_confirmed, applied_by)
     VALUES ($1, $2, 7, 9, '2020-07-01', '2021-06-30', '2021-08-31', 14, 'Aligned with the group year end.  ', true, true, $3) RETURNING id`,
    [co, transition, user])).rows[0].id;
  await pool.query(`UPDATE fiscal_years SET end_date = '2021-08-31', change_id = $2 WHERE id = $1`, [transition, change]);
  await addYear(2022, '2021-09-01', '2022-08-31');
});

afterAll(async () => {
  try {
    await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[co, bare]]).catch(() => undefined); // change rows are append-only
  } finally { await pool.end(); }
});

describe('getReportingPeriod branches', () => {
  it('a twelve-month year after a twelve-month year: comparable, no note', async () => {
    const p = await inTx(co, () => getReportingPeriod(co, 2019));
    // FY2018 is the template year before the first stored one: twelve months.
    expect(p.current.months).toBe(12);
    expect(p.prior.months).toBe(12);
    expect(p.comparable).toBe(true);
    expect(p.comparabilityNote).toBeNull();
  });

  it('a short year with no change record says the year is not twelve months long', async () => {
    const p = await inTx(co, () => getReportingPeriod(co, 2020));
    expect(p.current).toMatchObject({ start: '2020-01-01', end: '2020-06-30', months: 6, phrase: '6 months ended 2020-06-30', header: '6 months to 2020-06-30 (R)' });
    expect(p.comparable).toBe(false);
    expect(p.comparabilityNote).toBe(
      'These financial statements cover the 6 months from 2020-01-01 to 2020-06-30, because this financial year is not twelve months long. '
      + 'The comparative figures cover the year from 2019-01-01 to 2019-12-31. '
      + 'The amounts presented are therefore not entirely comparable (IAS 1.36).');
  });

  it('a transition year whose comparative is also short names the reason (trailing punctuation stripped) and both lengths', async () => {
    const p = await inTx(co, () => getReportingPeriod(co, 2021));
    expect(p.current.months).toBe(14);
    expect(p.prior).toMatchObject({ start: '2020-01-01', end: '2020-06-30', months: 6 });
    expect(p.comparable).toBe(false);
    expect(p.comparabilityNote).toBe(
      'These financial statements cover the 14 months from 2020-07-01 to 2021-08-31, '
      + 'because the entity changed its financial year end (Aligned with the group year end). '
      + 'The comparative figures cover the 6 months from 2020-01-01 to 2020-06-30. '
      + 'The amounts presented are therefore not entirely comparable (IAS 1.36).');
  });

  it('the year after a transition year: twelve months, comparative is the 14-month year', async () => {
    const p = await inTx(co, () => getReportingPeriod(co, 2022));
    expect(p.current.months).toBe(12);
    expect(p.prior.months).toBe(14);
    expect(p.comparabilityNote).toBe(
      'The comparative figures cover the 14 months from 2020-07-01 to 2021-08-31. '
      + 'The amounts presented are therefore not entirely comparable (IAS 1.36).');
  });
});

describe('findReportingPeriod', () => {
  it('answers the period for a label a year carries', async () => {
    expect((await inTx(co, () => findReportingPeriod(co, 2021, 'test')))?.current.months).toBe(14);
  });

  it('does not swallow any other failure: a company with no declared start month is refused loudly', async () => {
    await expect(inTx(bare, () => findReportingPeriod(bare, 2026, 'test'))).rejects.toBeInstanceOf(StartMonthAssumedError);
  });
});
