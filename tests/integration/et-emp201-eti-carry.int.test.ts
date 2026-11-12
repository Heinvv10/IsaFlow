/**
 * ETI carry-forward on the EMP201 (master plan wave 5, ET) against real PostgreSQL: the earlier months of the
 * reconciliation period are read from this company's declarable headers only (ETI Act s9(1)), and nothing carries
 * across the end of February or August (s10(1), s10(3)); the excess there is the refund claimable.
 * Disposable fixture DB only.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const coA = randomUUID();
const coB = randomUUID();

async function header(company: string, year: number, month: number, status: string, paye: number, eti: number): Promise<void> {
  await pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_paye, total_eti)
     VALUES ($1, $2, $3, $4, $5, $6)`, [company, year, month, status, paye, eti]);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [coA, 'ET carry A', coB, 'ET carry B']);
  await header(coA, 2026, 2, 'approved', 0, 1_000); // end of the September-February period
  await header(coA, 2026, 3, 'approved', 400, 0);
  await header(coA, 2026, 4, 'draft', 0, 9_999); // not declarable: never carried
  await header(coA, 2026, 5, 'approved', 200, 2_000);
  await header(coA, 2026, 6, 'paid', 3_000, 500);
  await header(coB, 2026, 5, 'approved', 0, 5_000); // another company: never carried
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_headers WHERE company_id = ANY($1::uuid[])', [[coA, coB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[coA, coB]]);
  } finally {
    await pool.end();
  }
});

describe('EMP201 ETI carry-forward', () => {
  it('June: May\'s R1 800 excess is brought forward; a draft month and another company carry nothing', async () => {
    const june = await generateEMP201(coA, '2026-06-01', '2026-06-30');
    expect(june.etiCarry).toEqual({ broughtForward: 1_800, used: 2_300, carriedForward: 0, refundClaimable: 0 });
    expect(june.totalETI).toBe(500);
    expect(june.payePayable).toBe(700);
  });

  it('February\'s excess is the refund claimable, not carried (s10(1), round 5 ruling), and March starts at nil', async () => {
    const feb = await generateEMP201(coA, '2026-02-01', '2026-02-28');
    expect(feb.etiCarry).toEqual({ broughtForward: 0, used: 0, carriedForward: 0, refundClaimable: 1_000 });
    const march = await generateEMP201(coA, '2026-03-01', '2026-03-31');
    expect(march.etiCarry.broughtForward).toBe(0);
    expect(march.payePayable).toBe(400);
  });
});
