/**
 * PAYE 4a follow-ups G4, breaker round 4 on PR B, ported: reopening an approved
 * month and approving it again unchanged is not refused by the stale
 * year-to-date gate (a later month calculated after its first approval saw it).
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
describe('BRK4', () => {
  it('reopen an approved month, change nothing, re-approve it: not refused', async () => {
    const f = await seedEmployee(pool, fixtures, 'brk6', 20_000);
    const ids: string[] = [];
    for (const p of PERIODS.slice(0, 11)) { const id = await mk(f, p.year, p.month); await calcOnly(f, id); expect((await approveRun(f, id)).statusCode).toBe(200); ids.push(id); }
    expect((await reopenRun(f, ids[9]!)).statusCode).toBe(200);
    const r = await approveRun(f, ids[9]!);
    expect(r.statusCode, JSON.stringify(r.body).slice(0, 300)).toBe(200);
  });
});
