/**
 * Marking an EMP501 filed takes the company's payroll approval lock (lockCompanyPayrollApprovals) BEFORE it reads the
 * drift (wave 6 EFb, review #1568), so an approval or reopen in flight and the filing see ONE payroll state. Real
 * PostgreSQL, two connections; the order is forced by holding the approval lock by hand on the second connection, as
 * an approval holds it for its transaction:
 *  - approval first: the holder rewrites the March PAYE (as a reopen + re-approve does) and commits only after the
 *    filing is seen waiting on the lock; the filing then reads the new payroll, finds drift, and is refused (409),
 *    leaving the version finalised. Without the lock the filing reads the old state and files a stale return (200).
 *  - filing proceeds once released: the holder changes nothing and commits; the waiting filing then files (200).
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { payrollApprovalLockScope } from '@/modules/accounting/services/payroll/payrollRunLock';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import returns from '../../pages/api/payroll/emp501/returns/index';
import filingFile from '../../pages/api/payroll/emp501/returns/filing-file';

type Row = Record<string, unknown>;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
const INTERIM = { periodStart: '2025-03-01', periodEnd: '2025-08-31' };
const fixtures: ReturnFixture[] = [];
let seeded3601 = false;

async function company(tag: string): Promise<{ rf: ReturnFixture; runId: string; versionId: string }> {
  assertNotProductionDb('This test seeds companies, employees, pay runs and return versions.');
  const rf = await seedReturnFixture(tag, DATABASE_URL!);
  fixtures.push(rf);
  const c = rf.fx.companyId;
  await sql`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada',
    sars_contact_last_name = 'Lovelace', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street',
    physical_postal_code = '0001', physical_city = 'Pretoria' WHERE id = ${c}::UUID`;
  const emp = String(((await sql`
    INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
    VALUES (${c}::UUID, 'E1', 'Test', 'Alice', '2020-01-01', '1980-01-01', '8001015009087', '0123456789') RETURNING id`) as Row[])[0]!.id);
  const runId = String(((await sql`
    INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, total_paye, approved_at)
    VALUES (${c}::UUID, 2025, 3, 'approved', 30000, 4000, '2025-04-01T10:00:00Z') RETURNING id`) as Row[])[0]!.id);
  await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
    VALUES (${runId}::UUID, ${emp}::UUID, 30000, 30000, 4000, 177.12, 177.12, 300, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 30000 }])}::JSONB)`;
  // March's EMP201, filed the legacy way without stored totals (not cross-checked, so it does not block the finalise).
  await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at)
    VALUES (${c}::UUID, 'EMP201', '2025-03-01', '2025-03-31', 'submitted', ${`LEGACY-${tag}`}, now())`;
  const f = await callRoute(returns, c, rf.admin.token, 'POST', {}, { action: 'finalise', ...INTERIM });
  expect(f.status, JSON.stringify(f.body)).toBe(200);
  const versionId = String(((await sql`SELECT id FROM tax_return_versions WHERE company_id = ${c}::UUID AND form_type = 'EMP501'`) as Row[])[0]!.id);
  expect((await callRoute(filingFile, c, rf.admin.token, 'POST', {}, { versionId })).status).toBe(200);
  return { rf, runId, versionId };
}

/** Resolves once some backend waits on an advisory lock (the filing, queued behind the holder), or after ~4 s. */
async function filingWaits(rf: ReturnFixture): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    const r = await rf.fx.pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'");
    if (r.rowCount) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

const versionStatus = async (versionId: string) =>
  String(((await sql`SELECT status FROM tax_return_versions WHERE id = ${versionId}::UUID`) as Row[])[0]!.status);

describeIfDb('EMP501 mark filed vs a payroll approval in flight (the approval lock)', () => {
  beforeAll(async () => {
    seeded3601 = ((await sql`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
      VALUES ('3601', 2026, 'income', 'Income', 'active') ON CONFLICT DO NOTHING RETURNING code`) as Row[]).length === 1;
    refreshCache();
  });

  afterAll(async () => {
    for (const rf of fixtures) {
      const c = rf.fx.companyId;
      await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c}::UUID)`;
      await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM payroll_employees WHERE company_id = ${c}::UUID`;
      await dropReturnFixture(rf);
    }
    if (seeded3601) await sql`DELETE FROM sars_source_codes WHERE code = '3601' AND effective_year = 2026`;
    refreshCache();
  }, 120000);

  it('approval first: the filing waits for it, then sees the changed payroll and is refused; the version stays finalised', async () => {
    const { rf, runId, versionId } = await company('LKA');
    const holder = await rf.fx.pool.connect();
    let filing: Promise<{ status: number; body: unknown }> | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [payrollApprovalLockScope(rf.fx.companyId)]);
      // The approval's own write, not yet committed: March's PAYE corrected (as a reopen + re-approve leaves it).
      await holder.query('UPDATE payroll_run_lines SET paye = 9000 WHERE run_id = $1', [runId]);
      await holder.query("UPDATE payroll_run_headers SET total_paye = 9000, approved_at = '2025-09-15T10:00:00Z' WHERE id = $1", [runId]);
      filing = callRoute(returns, rf.fx.companyId, rf.admin.token, 'POST', {}, { action: 'file', versionId, reference: 'EMP501RACE1' });
      expect(await filingWaits(rf), 'the filing must queue behind the approval lock').toBe(true);
      await holder.query('COMMIT');
    } catch (err) {
      await holder.query('ROLLBACK');
      throw err;
    } finally {
      holder.release();
    }
    const r = await filing!;
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/no longer matches the ledger or payroll/);
    expect(await versionStatus(versionId)).toBe('finalised');
    expect(await sql`SELECT 1 FROM sars_submissions WHERE company_id = ${rf.fx.companyId}::UUID AND form_type = 'EMP501'`).toHaveLength(0);
  });

  it('filing after the holder releases with nothing changed: the waiting filing files', async () => {
    const { rf, versionId } = await company('LKB');
    const holder = await rf.fx.pool.connect();
    let filing: Promise<{ status: number; body: unknown }> | null = null;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [payrollApprovalLockScope(rf.fx.companyId)]);
      filing = callRoute(returns, rf.fx.companyId, rf.admin.token, 'POST', {}, { action: 'file', versionId, reference: `EMP501RACE${randomUUID().slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, 'A')}` });
      expect(await filingWaits(rf), 'the filing must queue behind the approval lock').toBe(true);
      expect(await versionStatus(versionId)).toBe('finalised'); // still waiting
      await holder.query('COMMIT');
    } catch (err) {
      await holder.query('ROLLBACK');
      throw err;
    } finally {
      holder.release();
    }
    const r = await filing!;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await versionStatus(versionId)).toBe('filed');
  });
});
