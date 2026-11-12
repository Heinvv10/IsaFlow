/**
 * Wave 5 DR, #1266 round 4 L: POST /api/accounting/tax-directives/[id]/apply on a fixed-percentage / fixed-amount
 * directive answers 400 "each run applies it" BEFORE ET's wrapper (directivePaymentEti) takes the company lock and judges
 * later ETI journals, so in an ETI period with a later month's journal in force the caller does not get the ETI 409.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  applyStandalone, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, type SeveranceFixture,
} from './p3-severance.helpers';
import { drFixture, patchDirective, PCT, postDirective } from './w5-dr.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const made: SeveranceFixture[] = [];
afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_log WHERE company_id = ANY($1) AND entity_type = 'tax_directive'", [made.map(f => f.company)]);
    await cleanSeveranceFixtures(pool, made);
  } finally { await pool.end(); }
});

describe('apply on a regular-pay directive in an ETI period with a later journal in force', () => {
  it('400 TaxDirectiveNotLumpSum, not the ETI 409; no payment row', async () => {
    const f = await drFixture(pool, 'DR r4 apply ETI');
    made.push(f);
    const d = String((await postDirective(f, { ...PCT, effective_date: '2026-06-01' })).body.data!.id);
    expect((await patchDirective(f, d, { status: 'approved' })).statusCode).toBe(200);
    for (const month of [3, 4]) {
      const run = await createRunFor(f, month);
      await calculateRun(f, run);
      expect((await approveRun(f, run)).statusCode).toBe(200);
    }
    // March carries ETI, so the March-August period has ETI and April's run journal is a later month in force.
    await pool.query('UPDATE payroll_run_headers SET total_eti = 100 WHERE company_id = $1 AND period_month = 3', [f.company]);
    const r = await applyStandalone(f, d, '2026-03-15');
    expect(r.statusCode, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error?.message).toMatch(/cannot be paid as a lump sum/);
    expect((await pool.query('SELECT count(*)::int AS n FROM tax_directive_payments WHERE tax_directive_id = $1', [d])).rows[0]!.n).toBe(0);
  });
});
