// Blind review #1566 merge: EFb's EMP501 finalise vs PSP lines (repro).
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import { refreshCache } from '../../src/modules/accounting/services/payroll/sarsCodesService';
import { pspLineFlag } from '../../src/modules/accounting/services/payroll/payrollOutsideTables';
import returns from '../../pages/api/payroll/emp501/returns/index';

type Row = Record<string, unknown>;
const INTERIM = { periodStart: '2025-03-01', periodEnd: '2025-08-31' };
let rf: ReturnFixture;
const c = () => rf.fx.companyId;
let seeded3601 = false;

describe('EMP501 finalise with a PSP line in the period', () => {
  beforeAll(async () => {
    assertNotProductionDb('seeds');
    rf = await seedReturnFixture('PSPM', process.env.DATABASE_URL!);
    seeded3601 = ((await sql`INSERT INTO sars_source_codes (code, effective_year, category, description, status)
      VALUES ('3601', 2026, 'income', 'Income', 'active') ON CONFLICT DO NOTHING RETURNING code`) as Row[]).length === 1;
    refreshCache();
    await sql`UPDATE companies SET paye_reference_number = '7123456789', sars_contact_first_name = 'Ada',
      sars_contact_last_name = 'Lovelace', sars_contact_telephone = '0110000000', physical_address_line1 = '1 Fixture Street',
      physical_postal_code = '0001', physical_city = 'Pretoria' WHERE id = ${c()}::UUID`;
    const alice = String(((await sql`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number)
      VALUES (${c()}::UUID, 'A1', 'Test', 'Alice', '2020-01-01', '1980-01-01', '8001015009087', '0123456789') RETURNING id`) as Row[])[0]!.id);
    const psp = String(((await sql`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number, tax_number, tax_status, psp_entity_type)
      VALUES (${c()}::UUID, 'P1', 'Trust', 'Psp', '2020-01-01', '1980-01-01', '8001015009087', '0123456788', 'personal_service_provider', 'trust') RETURNING id`) as Row[])[0]!.id);
    const run = String(((await sql`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, total_gross, approved_at)
      VALUES (${c()}::UUID, 2025, 3, 'approved', 0, '2025-04-01T10:00:00Z') RETURNING id`) as Row[])[0]!.id);
    await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown)
      VALUES (${run}::UUID, ${alice}::UUID, 30000, 30000, 4000, 177.12, 177.12, 300, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 30000 }])}::JSONB)`;
    await sql`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, component_breakdown, validation_results)
      VALUES (${run}::UUID, ${psp}::UUID, 50000, 50000, 22500, 0, 0, 500, ${JSON.stringify([{ sarsSourceCode: '3601', amount: 50000 }])}::JSONB, ${pspLineFlag}::JSONB)`;
    // The March EMP201 as filed: every line's PAYE/UIF/SDL (the EMP201 carries the PSP's PAYE and SDL).
    await sql`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status, submission_reference, submitted_at, form_data)
      VALUES (${c()}::UUID, 'EMP201', '2025-03-01', '2025-03-31', 'submitted', 'LEGACY-EMP201', now(),
        ${JSON.stringify({ totalPAYE: 26500, totalUIF: 354.24, totalSDL: 800 })}::JSONB)`;
  }, 240000);

  afterAll(async () => {
    if (!rf) return;
    await sql`DELETE FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = ${c()}::UUID)`;
    await sql`DELETE FROM payroll_run_headers WHERE company_id = ${c()}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE company_id = ${c()}::UUID`;
    if (seeded3601) await sql`DELETE FROM sars_source_codes WHERE code = '3601' AND effective_year = 2026`;
    refreshCache();
    await dropReturnFixture(rf);
  }, 120000);

  it('readiness is green (EMP201 = every line), and finalise succeeds', async () => {
    const g = await callRoute(returns, c(), rf.admin.token, 'GET', INTERIM);
    console.log('READINESS', JSON.stringify((g.body as { data: { readiness: Row } }).data.readiness));
    const r = await callRoute(returns, c(), rf.admin.token, 'POST', {}, { action: 'finalise', ...INTERIM });
    console.log('FINALISE', r.status, JSON.stringify(r.body));
    expect(r.status).toBe(200);
  });
});
