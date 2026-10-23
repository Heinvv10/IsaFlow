/**
 * Feature I: financial years are generated on demand by one code path
 * (gl/fiscalYearGenerator over migration 942's fiscal_year_ensure +
 * fiscal_periods_generate). Companies are no longer pre-seeded.
 *
 * Disposable schema fixture only (assertDisposable). All data synthetic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { ensureFiscalPeriodForDate, FiscalPeriodNotGeneratedError } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callSetup, dropSetupUsers, newSetupUser, setupBody, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const users: SetupUser[] = [];
const bare: string[] = [];

afterAll(async () => {
  try {
    for (const u of users) {
      const owned = (await pool.query('SELECT company_id FROM company_users WHERE user_id = $1', [u.userId])).rows
        .map((r: { company_id: string }) => r.company_id);
      for (const id of owned) await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [id]);
    }
    await dropSetupUsers(pool, users);
    for (const id of bare) {
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM afs_statement_lines WHERE company_id = $1', [id]).catch(() => undefined);
      await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    }
  } finally { await pool.end(); }
}, 60000);

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = new Date();
const y = TODAY.getFullYear();
/** The March-start year holding today: [label, start, end]. */
const marchYear = TODAY.getMonth() + 1 >= 3
  ? [y + 1, `${y}-03-01`, `${y + 1}-02-${new Date(y + 1, 2, 0).getDate()}`]
  : [y, `${y - 1}-03-01`, `${y}-02-${new Date(y, 2, 0).getDate()}`];

const yearsOf = async (companyId: string) => (await pool.query(
  `SELECT fiscal_year, start_date::text AS s, end_date::text AS e,
          (SELECT COUNT(*)::int FROM fiscal_periods fp WHERE fp.fiscal_year_id = fy.id) AS periods
     FROM fiscal_years fy WHERE company_id = $1 ORDER BY start_date`, [companyId])).rows;

async function bareCompany(fyStart: number): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYGEN bare', $2)`, [id, fyStart]);
  bare.push(id);
  return id;
}

/** Run fn as withAuth would: one client, BEGIN, the request context. */
async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: crypto.randomUUID(), claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

describe('no pre-seeding', () => {
  it('the company taxonomy seeder no longer writes any fiscal period', async () => {
    const id = await bareCompany(3);
    await pool.query('SELECT public.seed_company_default_taxonomy($1)', [id]);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM fiscal_periods WHERE company_id = $1', [id])).rows[0].n).toBe(0);
    expect(await yearsOf(id)).toEqual([]);
  });

  it('onboarding (March start) ends with exactly one year, March to February, holding today', async () => {
    const u = await newSetupUser(pool);
    users.push(u);
    const out = await callSetup(u, setupBody('other'));
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(await yearsOf(out.body.data!.companyId!)).toEqual([
      { fiscal_year: marchYear[0], s: marchYear[1], e: marchYear[2], periods: 12 }]);
  });
});

describe('on demand', () => {
  it('a posting dated in the following year creates that year, March to February', async () => {
    const id = await bareCompany(3);
    await inTx(id, () => generateFiscalYearForDate(id, iso(TODAY)));
    const next = `${Number(marchYear[0])}-06-15`;
    const periodId = await inTx(id, () => ensureFiscalPeriodForDate(id, next));
    expect(periodId).not.toBeNull();
    const ys = await yearsOf(id);
    expect(ys.map((r) => [r.fiscal_year, r.s, r.periods])).toEqual([
      [marchYear[0], marchYear[1], 12], [Number(marchYear[0]) + 1, `${marchYear[0]}-03-01`, 12]]);
  });

  it('continues from the last stored year, not from the declared month', async () => {
    const id = await bareCompany(3);
    await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date) VALUES ($1, 2026, '2026-01-01', '2026-12-31')`, [id]);
    await inTx(id, () => generateFiscalYearForDate(id, '2027-05-10'));
    expect((await yearsOf(id)).map((r) => [r.fiscal_year, r.s, r.e])).toEqual([
      [2026, '2026-01-01', '2026-12-31'], [2027, '2027-01-01', '2027-12-31']]);
  });

  it('a June year end generates July-June years numbered 1-12 from July', async () => {
    const id = await bareCompany(7);
    await inTx(id, () => generateFiscalYearForDate(id, '2026-09-10'));
    const rows = (await pool.query(
      `SELECT fiscal_year, period_number, start_date::text s FROM fiscal_periods WHERE company_id = $1 ORDER BY start_date`, [id])).rows;
    expect(rows[0]).toEqual({ fiscal_year: 2027, period_number: 1, s: '2026-07-01' });
    expect(rows[11]).toEqual({ fiscal_year: 2027, period_number: 12, s: '2027-06-01' });
  });

  it('fills a missing month inside an existing year instead of leaving the date uncovered', async () => {
    const id = await bareCompany(3);
    await inTx(id, () => generateFiscalYearForDate(id, '2026-05-01'));
    await pool.query(`DELETE FROM fiscal_periods WHERE company_id = $1 AND start_date = '2026-08-01'`, [id]);
    const periodId = await inTx(id, () => ensureFiscalPeriodForDate(id, '2026-08-20'));
    const p = (await pool.query('SELECT fiscal_year, period_number FROM fiscal_periods WHERE id = $1', [periodId])).rows[0];
    expect(p).toEqual({ fiscal_year: 2027, period_number: 6 });
  });

  it('does not fill a month in a year that holds a closed period (no back-dating beside closed books)', async () => {
    const id = await bareCompany(3);
    await inTx(id, () => generateFiscalYearForDate(id, '2026-05-01'));
    await pool.query(`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1 AND start_date = '2026-03-01'`, [id]);
    await pool.query(`DELETE FROM fiscal_periods WHERE company_id = $1 AND start_date = '2026-08-01'`, [id]);
    // Refused, not null: createJournalEntry stores a null as fiscal_period_id NULL, and
    // postJournalEntry then posts the journal past its closed-period check, outside
    // every period-bounded report.
    await expect(inTx(id, () => ensureFiscalPeriodForDate(id, '2026-08-20')))
      .rejects.toBeInstanceOf(FiscalPeriodNotGeneratedError);
    const august = await pool.query(`SELECT 1 FROM fiscal_periods WHERE company_id = $1 AND start_date = '2026-08-01'`, [id]);
    expect(august.rowCount).toBe(0);
  });

  it('continues legacy January-December labels for a company whose periods carry them', async () => {
    const id = await bareCompany(3);
    await pool.query(
      `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
       SELECT $1, TO_CHAR(MAKE_DATE(2026, m, 1), 'FMMonth YYYY'), m, 2026, MAKE_DATE(2026, m, 1),
              (MAKE_DATE(2026, m, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date
         FROM generate_series(1, 12) m`, [id]);
    await inTx(id, () => ensureFiscalPeriodForDate(id, '2027-01-15'));
    const jan = (await pool.query(
      `SELECT fiscal_year, period_number FROM fiscal_periods WHERE company_id = $1 AND start_date = '2027-01-01'`, [id])).rows[0];
    expect(jan).toEqual({ fiscal_year: 2027, period_number: 1 });
    // ...while the YEAR is still the declared March one.
    expect((await yearsOf(id)).map((r) => [r.fiscal_year, r.s, r.e])).toEqual([
      [2026, '2025-03-01', '2026-02-28'], [2027, '2026-03-01', '2027-02-28']]);
  });
});

describe('no silent March', () => {
  it('the generator refuses a company with no usable financial_year_start; a read assumes March and says so by name', async () => {
    const id = await bareCompany(3);
    await pool.query('UPDATE companies SET financial_year_start = NULL WHERE id = $1', [id]);
    await expect(inTx(id, () => generateFiscalYearForDate(id, '2026-05-01'))).rejects.toThrow(/no usable financial_year_start/);
    expect(await yearsOf(id)).toEqual([]);
    const read = (await pool.query(`SELECT start_date::text s, stored FROM public.fiscal_year_for_date($1, '2026-05-01')`, [id])).rows[0];
    expect(read).toEqual({ s: '2026-03-01', stored: false });
  });
});

describe('concurrency', () => {
  it('two first postings into the same new year create one year, and neither fails', async () => {
    const id = await bareCompany(3);
    const a: PoolClient = await pool.connect();
    const b: PoolClient = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = await generateFiscalYearForDate(id, '2026-04-10', a);
      // b now blocks on a's uncommitted year (the unique key / overlap EXCLUDE)...
      let bDone = false;
      const second = generateFiscalYearForDate(id, '2026-11-02', b).then((r) => { bDone = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      expect(bDone).toBe(false);
      await a.query('COMMIT');
      // ...and, once a commits, reads a's year instead of failing.
      const got = await second;
      await b.query('COMMIT');
      expect(got.fiscalYearId).toBe(first.fiscalYearId);
      expect(first.periodsCreated).toBe(12);
      expect(got.periodsCreated).toBe(0);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release(); b.release();
    }
    expect((await yearsOf(id)).map((r) => [r.fiscal_year, r.periods])).toEqual([[2027, 12]]);
  });
});
