import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../scripts/forensic/fixture-bootstrap';
import { ensureOpenPeriod, provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from './forensic-fixture';

/**
 * Unit-level proof of the ensureOpenPeriod helper's insert branch — the branch that only runs once
 * a target date has NO covering period, which "today" in September 2026 never exercises because
 * every arSharedWriters/historicalImportExecution/apSharedWriters test still has the fixture's own
 * hard-coded September 2026 period sitting there. Executing the branch itself needs no moved clock:
 * these dates are chosen so nothing covers them. The kernel's own "what covers today" lookup
 * (arOperationMaterializer.ts, apReversalMaterial.ts) still reads the real DB clock and is exercised
 * only by an actual moved-clock run, not by this file.
 */
const config = fixtureConfigFromEnv(process.env);
const target = validateFixtureTarget(config);
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 2 });
let fixture: ForensicFixture;
beforeAll(async () => { fixture = await provisionForensicFixture(config); });
afterAll(async () => { await pool.end(); });

async function periodRow(id: string) {
  const { rows: [row] } = await pool.query(
    'SELECT period_number,fiscal_year,start_date::text,end_date::text,status FROM fiscal_periods WHERE id=$1', [id]);
  return row;
}

it('reproduces the duplicate-key bug the calendar-month-as-period_number scheme has for two dates in one month', async () => {
  // This is the OLD apSharedWriters.int.test.ts ensureOpenPeriod logic, inlined verbatim (not
  // imported — it was deleted from the test file by the fix below) to prove what it does wrong.
  async function oldEnsureOpenPeriod(dateStr: string): Promise<string> {
    const covering = await pool.query(
      "SELECT id FROM fiscal_periods WHERE company_id=$1 AND status='open' AND start_date<=$2::date AND end_date>=$2::date",
      [fixture.companyA, dateStr]);
    if (covering.rows[0]) return covering.rows[0].id as string;
    const id = randomUUID(), date = new Date(`${dateStr}T00:00:00Z`);
    await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
      VALUES($1,$2,'Synthetic old-scheme period',$3,$4,$5::date,$5::date,'open')`,
      [id, fixture.companyA, date.getUTCMonth() + 1, date.getUTCFullYear(), dateStr]);
    return id;
  }
  await oldEnsureOpenPeriod('2026-10-01');
  await expect(oldEnsureOpenPeriod('2026-10-02')).rejects.toThrow(/uq_fiscal_periods_company_year_period|duplicate key/);
});

it('inserts exactly one open period per distinct uncovered date, never colliding on period_number, and reuses it on a second call', async () => {
  const first = await ensureOpenPeriod(pool, fixture.companyA, '2026-10-01', 'Synthetic proof period');
  const second = await ensureOpenPeriod(pool, fixture.companyA, '2026-10-02', 'Synthetic proof period');
  expect(first).not.toBe(second);
  expect(await periodRow(first)).toMatchObject({ fiscal_year: 2026, start_date: '2026-10-01', end_date: '2026-10-01', status: 'open' });
  expect(await periodRow(second)).toMatchObject({ fiscal_year: 2026, start_date: '2026-10-02', end_date: '2026-10-02', status: 'open' });
  expect((await periodRow(first))!.period_number).not.toBe((await periodRow(second))!.period_number);

  // Reuse: calling again for the same date returns the same period, no second insert.
  expect(await ensureOpenPeriod(pool, fixture.companyA, '2026-10-01', 'Synthetic proof period')).toBe(first);

  // A third distinct date the same month must still not collide on (company,fiscal_year,period_number).
  const third = await ensureOpenPeriod(pool, fixture.companyA, '2026-10-15', 'Synthetic proof period');
  expect(third).not.toBe(first);
  expect(third).not.toBe(second);
});

it('crosses a fiscal year boundary without colliding, including a same-month third date the year after', async () => {
  const dec31 = await ensureOpenPeriod(pool, fixture.companyA, '2026-12-31', 'Synthetic year-boundary period');
  const jan1 = await ensureOpenPeriod(pool, fixture.companyA, '2027-01-01', 'Synthetic year-boundary period');
  const jan15 = await ensureOpenPeriod(pool, fixture.companyA, '2027-01-15', 'Synthetic year-boundary period');
  expect(new Set([dec31, jan1, jan15]).size).toBe(3);
  expect((await periodRow(dec31))!.fiscal_year).toBe(2026);
  expect((await periodRow(jan1))!.fiscal_year).toBe(2027);
  expect((await periodRow(jan15))!.fiscal_year).toBe(2027);
  expect((await periodRow(jan1))!.period_number).not.toBe((await periodRow(jan15))!.period_number);
});
