/**
 * TS-b on real Postgres: the real writer and year-to-date loader (calculatePayrollRun, loadPayeYearToDate) under SARS
 * PAYE-GEN-01-G21 (2027) Rev 1 p. 26 (independent contractor) and p. 28 (non-standard employment, 25%).
 *
 * A month whose PAYE did not come from the tables is no table period: the next table month is costed as a first period,
 * not trued up against it. A change of the work terms after calculation sends the run back (payrollRunRecalcGate).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanSeveranceFixtures, type SeveranceFixture } from './p3-severance.helpers';
import { seedEmployee } from './p4fu-cumulative.helpers';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { FLAT, STANDARD, run } from './ts-b.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-07-15T12:00:00+02:00'));
});
afterAll(async () => {
  vi.useRealTimers();
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('a month off the tables leaves the cumulative base', () => {
  it('a flat 25% month, then a table month: the table month is a first period (2 115), not trued up', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb flat then tables', 20_000);
    const march = await run(pool, f, 3, FLAT);
    expect(march.line.paye).toBe(5_000);
    expect(march.line.results.map(r => r.code)).toContain('PAYE_OUTSIDE_TABLES');
    const april = await run(pool, f, 4, STANDARD);
    expect(april.line.paye).toBe(2_115);
    const ytd = (await loadPayeYearToDate(f.company, crypto.randomUUID(), { month: 5, year: 2026 }, [f.employee])).get(f.employee)!;
    expect([ytd.periods, ytd.periodicTaxable, ytd.tablePaye]).toEqual([1, 20_000, 2_115]);
  });

  it('a contractor month takes no PAYE, UIF, SDL or ETI, and the next table month is a first period', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb contractor then tables', 20_000);
    const march = await run(pool, f, 3, { taxStatus: 'independent_contractor' });
    expect([march.line.paye, march.line.uif, march.line.sdl, march.line.eti]).toEqual([0, 0, 0, 0]);
    expect((await run(pool, f, 4, STANDARD)).line.paye).toBe(2_115);
  });

  it('a flat month keeps its SDL pay and takes UIF (an employee); a contractor month has none', async () => {
    const f = await seedEmployee(pool, fixtures, 'tsb flat sdl', 20_000);
    const flat = await run(pool, f, 3, FLAT);
    expect([flat.line.applicable, flat.line.uif]).toEqual([20_000, 177.12]);
    const contractor = await run(pool, f, 4, { taxStatus: 'independent_contractor' });
    expect(contractor.line.applicable).toBe(0);
  });
});
