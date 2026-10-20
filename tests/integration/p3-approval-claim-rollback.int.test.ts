/**
 * Audit 2026-10-18 P3, review round 2 (security): approval writes two things a
 * refusal may still follow — the run's claim on its severance directives and,
 * for a run whose journal was reversed, the unlink of that journal. A refusal
 * is a 4xx, which withAuth COMMITs, so both are in one savepoint: a claim
 * refused (a peer paid the directive between the gate and the claim) must
 * leave the old journal linked. The claim is made to refuse here; the race
 * that produces the refusal is p3-severance-directive-race. Real routes;
 * disposable database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const refuse = vi.hoisted(() => ({ on: false }));
vi.mock('@/modules/accounting/services/payroll/payrollRunDirectiveClaim', async (orig) => {
  const actual = await orig<typeof import('@/modules/accounting/services/payroll/payrollRunDirectiveClaim')>();
  const { PayrollApprovalRefusedError } = await import('@/modules/accounting/services/payroll/payrollApprovalRefusal');
  return {
    ...actual,
    claimRunSeveranceDirectives: async (...a: Parameters<typeof actual.claimRunSeveranceDirectives>) => {
      await actual.claimRunSeveranceDirectives(...a);
      if (refuse.on) throw new PayrollApprovalRefusedError('Cannot approve: the severance was paid under its SARS directive meanwhile.');
    },
  };
});

import jeAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import {
  approvedDirective, approveRun, calculateRun, cleanSeveranceFixtures, createRunFor, directivePayments,
  reopenRun, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let f: SeveranceFixture;

beforeAll(async () => { f = await seedRetrenchedEmployee(pool, '2026-06-30', 'P3 claim + unlink rollback'); });
afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, [f]); } finally { await pool.end(); }
});

describe('P3: a refused claim on the replace path', () => {
  it('leaves the reversed journal linked, the run unapproved and the claim as it was', async () => {
    const d = await approvedDirective(f, 10_000, 0.1, '2026-06-01');
    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect((await approveRun(f, june)).statusCode).toBe(200);
    expect((await reopenRun(f, june)).statusCode).toBe(200);
    const journal = String((await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [june])).rows[0]!.journal_entry_id);
    const reversed = await f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id: journal, action: 'reverse' } });
    expect(reversed.statusCode).toBe(200);
    const claimBefore = await directivePayments(pool, d);

    refuse.on = true;
    const refused = await approveRun(f, june);
    refuse.on = false;
    expect(refused.statusCode).toBe(400);
    const header = (await pool.query('SELECT status, journal_entry_id FROM payroll_run_headers WHERE id = $1', [june])).rows[0];
    expect(header).toEqual({ status: 'calculated', journal_entry_id: journal });
    expect(await directivePayments(pool, d)).toEqual(claimBefore);

    // Not refused: the same approval goes through onto a fresh journal.
    expect((await approveRun(f, june)).statusCode).toBe(200);
    const after = (await pool.query('SELECT journal_entry_id FROM payroll_run_headers WHERE id = $1', [june])).rows[0]!.journal_entry_id;
    expect(after).not.toBe(journal);
  });
});
