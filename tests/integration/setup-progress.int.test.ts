// tests/integration/setup-progress.int.test.ts
//
// Real-PG proof for the Home setup checklist (master-plan W1 PR C): every probe is
// scoped to the company, a row flips exactly its own task, and another tenant's rows
// never count.
// ci-integration-skip: skipped when DATABASE_URL is unset (the gate always sets it).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getSetupProgress, probeSetupFacts } from '@/modules/accounting/services/core/setupProgressService';

const DATABASE_URL = process.env.DATABASE_URL;
const A = '00000000-0000-0000-0000-0000000c0a01';
const B = '00000000-0000-0000-0000-0000000c0b01';

const describeIfDb = DATABASE_URL ? describe : describe.skip;

async function task(companyId: string, moduleId: string, taskId: string): Promise<boolean> {
  const p = await getSetupProgress(companyId);
  return p.modules.find((m) => m.id === moduleId)!.tasks.find((t) => t.id === taskId)!.done;
}

describeIfDb('setup progress probes', () => {
  let admin: Pool;

  async function cleanup() {
    for (const t of ['payroll_run_headers', 'payroll_employees', 'customers']) {
      await admin.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
    }
    await admin.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
  }

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes company fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup();
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1,'Setup Fixture A',true),($2,'Setup Fixture B',true)`,
      [A, B]);
  });

  afterAll(async () => {
    try { await cleanup(); } finally { await admin.end(); }
  });

  it('company with 0 employees has the Payroll task open; inserting one completes it', async () => {
    expect(await task(A, 'payroll', 'employees')).toBe(false);
    await admin.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
       VALUES ($1,'E1','Setup','Employee','2026-01-01','active')`, [A]);
    expect(await task(A, 'payroll', 'employees')).toBe(true);
  });

  it('a terminated employee does not count as an employee', async () => {
    await admin.query(
      `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, status)
       VALUES ($1,'E9','Gone','Employee','2025-01-01','terminated')`, [B]);
    expect(await task(B, 'payroll', 'employees')).toBe(false);
  });

  it("another company's rows never count (customers, employees, payroll runs)", async () => {
    await admin.query(`INSERT INTO customers (company_id, name) VALUES ($1,'Only A customer')`, [A]);
    await admin.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1,1,2026,'draft')`, [A]);
    const a = await probeSetupFacts(A);
    const b = await probeSetupFacts(B);
    expect(a.customers).toBe(1);
    expect(a.employees).toBe(1);
    expect(a.payrollRuns).toBe(1);
    expect(b.customers).toBe(0);
    expect(b.employees).toBe(0);
    expect(b.payrollRuns).toBe(0);
    expect(await task(B, 'sales', 'customers')).toBe(false);
  });

  it('PAYE reference and VAT settings come from the company row', async () => {
    await admin.query(
      `UPDATE companies SET paye_reference_number = '7123456789', vat_number = '4123456789', vat_period = 'bi-monthly' WHERE id = $1`, [A]);
    expect(await task(A, 'payroll', 'paye-reference')).toBe(true);
    expect(await task(A, 'tax', 'vat-number')).toBe(true);
    expect(await task(B, 'payroll', 'paye-reference')).toBe(false);
  });

  it("a company with vat_period 'none' has no Tax checklist", async () => {
    await admin.query(`UPDATE companies SET vat_period = 'none' WHERE id = $1`, [B]);
    const p = await getSetupProgress(B);
    expect(p.modules.some((m) => m.id === 'tax')).toBe(false);
  });
});
