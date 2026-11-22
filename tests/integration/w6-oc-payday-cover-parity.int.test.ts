/**
 * Review L3 of 61c35e98c5: approvalCoveredPaydaySql (the cash forecast's "disbursed") and approvalCoveredPayday (the
 * off-cycle pay-date gate) are one predicate. Each literal approval history is judged by both, in PostgreSQL and in TS,
 * for a 20 Nov 2026 payday: [2026-11-19 22:00 UTC, 2026-11-20 22:00 UTC).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { approvalCoveredPayday, approvalCoveredPaydaySql } from '@/modules/accounting/services/payroll/payrollPaydayCover';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(async () => { await pool.end(); });

const D = '2026-11-20';
const CASES: Array<[string, boolean]> = [
  ['{["2026-11-10 08:00:00+00","2026-11-20 12:00:00+00")}', true], // reopened on payday
  ['{["2026-11-20 08:00:00+00","2026-11-20 13:00:00+00")}', true], // approved and reopened on payday
  ['{["2026-11-10 08:00:00+00","2026-11-12 08:00:00+00")}', false], // reopened before payday
  ['{["2026-11-21 08:00:00+00","2026-11-25 08:00:00+00")}', false], // approved after payday
  ['{["2026-11-10 08:00:00+00","2026-11-19 22:00:00+00")}', false], // ends as payday starts (exclusive)
  ['{["2026-11-10 08:00:00+00","2026-11-19 22:00:00+00"]}', true], // ends as payday starts (inclusive)
  ['{["2026-11-10 08:00:00+00","2026-11-19 21:00:00+00")}', false], // ends an hour before payday
  ['{["2026-11-10 08:00:00+00","2026-11-19 22:00:00.0005+00")}', true], // half a millisecond into payday
  ['{["2026-11-20 22:00:00+00","2026-11-25 08:00:00+00")}', false], // starts as payday ends
  ['{["2026-11-20 21:59:59.999999+00","2026-11-25 08:00:00+00")}', true], // a microsecond before payday ends
  ['{["2026-11-18 08:00:00+00",)}', true], // still approved (unbounded)
  ['{[-infinity,"2026-11-20 00:00:00+00")}', true],
  ['{["2026-11-01 08:00:00+00","2026-11-02 08:00:00+00"),["2026-11-21 08:00:00+00",infinity)}', false],
  ['{}', false],
];

describe('approvalCoveredPaydaySql agrees with approvalCoveredPayday', () => {
  it.each(CASES)('%s → %s', async (history, expected) => {
    // The history as pg prints it, so TS reads the same text the forecast's rows and the gate's row carry.
    const row = (await pool.query(`SELECT h.approval_history::text AS text, ${approvalCoveredPaydaySql('h')} AS covered
      FROM (VALUES ($1::tstzmultirange, $2::date, $2::date)) AS h(approval_history, run_date, period_end)`, [history, D])).rows[0];
    expect(row.covered, `SQL ${row.text}`).toBe(expected);
    expect(approvalCoveredPayday(row.text, D), `TS ${row.text}`).toBe(expected);
    expect(approvalCoveredPayday(history, D), `TS literal ${history}`).toBe(expected);
  });
});
