/**
 * PAYE 4a follow-ups G4, breaker round 5 on PR B, ported: calculation now takes
 * the company approval lock (before its header lock, approval's order).
 * Concurrent calculate / approve / reopen across runs of one company end
 * without a deadlock or a server error.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import createRun from '../../pages/api/payroll/runs';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import {
  approveRun, reopenRun, cleanSeveranceFixtures, runLine, type SeveranceFixture,
} from './p3-severance.helpers';
import { PERIODS, seedEmployee, setSalary } from './p4fu-cumulative.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

async function mk(f: SeveranceFixture, year: number, month: number): Promise<string> {
  const made = await f.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  if (made.statusCode !== 201) throw new Error(`create: ${made.statusCode}`);
  return String(made.body.data!.id);
}
async function calcOnly(f: SeveranceFixture, id: string) {
  const calc = await f.call(calculate as Route, 'POST', `/api/payroll/runs/${id}/calculate`, id);
  if (calc.statusCode !== 200) throw new Error(`calc ${calc.statusCode}`);
}
describe('G4: calculate takes the company approval lock', () => {
  it('concurrent calculate / approve / reopen across runs: no 5xx', async () => {
    for (let i = 0; i < 4; i++) {
      const f = await seedEmployee(pool, fixtures, 'dl' + i, 20_000);
      const ids: string[] = [];
      for (const p of PERIODS.slice(0, 5)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); if (p.month < 6) { if ((await approveRun(f, id)).statusCode !== 200) throw new Error('setup'); } ids.push(id); }
      const c = await mk(f, 2026, 8); const d = await mk(f, 2026, 9);
      await calcOnly(f, c);
      const rs = await Promise.all([
        f.call(calculate as Route, 'POST', `/api/payroll/runs/${d}/calculate`, d),
        approveRun(f, c),
        reopenRun(f, ids[0]!),
        f.call(calculate as Route, 'POST', `/api/payroll/runs/${c}/calculate`, c),
      ]);
      expect(rs.every(r => r.statusCode < 500)).toBe(true);
    }
  });
});
