/**
 * Phase 5 Payroll Demo Seeder
 *
 * Layered on top of seed-payroll-data.ts — assumes the baseline 10
 * employees, 6 components, and 3 runs already exist. Adds just the
 * Phase 5 data so the browser can exercise:
 *   - cost centres + cost-centre GL mappings
 *   - per-employee cost-allocation splits
 *   - pay scales + employee assignments
 *   - pay packages + one materialised application
 *   - payment_method flip + equity/occupational_level + foreign flag
 *   - training events (WSP/ATR data)
 *   - one pre-existing history entry so the detail page has a timeline
 *
 * Run with:
 *   DATABASE_URL=$(...) bun scripts/seed-phase5-payroll.ts
 *
 * Safe to re-run — deletes Phase-5 rows for the demo company before
 * inserting.
 */

import { createSql, closeSql } from './_pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}
const sql = createSql(DATABASE_URL);

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID = 'admin-001';

async function main(): Promise<void> {
  console.log('=== Phase 5 Payroll Seeder ===');
  console.log(`Company: ${COMPANY_ID}\n`);

  // ── Clean any prior Phase 5 rows ──────────────────────────────────────
  await sql`DELETE FROM payroll_employee_cost_allocations WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM payroll_employee_history WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM cost_centre_gl_mappings WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM training_events WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM pay_package_components WHERE package_id IN (SELECT id FROM pay_packages WHERE company_id = ${COMPANY_ID}::uuid)`;
  await sql`DELETE FROM pay_packages WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`UPDATE payroll_employees SET pay_scale_id = NULL, occupational_level_id = NULL, is_foreign_national = false, payment_method = 'eft' WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM pay_scales WHERE company_id = ${COMPANY_ID}::uuid`;
  // Cost centres may already exist from older Phase 4 seed; wipe for clean state
  await sql`UPDATE payroll_employees SET cost_centre_id = NULL WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM cost_centres WHERE company_id = ${COMPANY_ID}::uuid`;
  console.log('[clean] prior Phase 5 rows removed');

  // ── Cost centres ──────────────────────────────────────────────────────
  const centreSpecs = [
    { code: 'ADMIN', name: 'Administration' },
    { code: 'OPS', name: 'Operations' },
    { code: 'SALES', name: 'Sales' },
  ];
  const centreRows = (await sql`
    INSERT INTO cost_centres (company_id, code, name, created_by)
    SELECT ${COMPANY_ID}::uuid, v.code, v.name, ${ADMIN_ID}
      FROM (VALUES
        (${centreSpecs[0]!.code}, ${centreSpecs[0]!.name}),
        (${centreSpecs[1]!.code}, ${centreSpecs[1]!.name}),
        (${centreSpecs[2]!.code}, ${centreSpecs[2]!.name})
      ) AS v(code, name)
    RETURNING id, code
  `) as Array<{ id: string; code: string }>;
  const centreByCode = Object.fromEntries(centreRows.map(r => [r.code, r.id]));
  console.log(`[cost-centres] created ${centreRows.length}`);

  // ── GL mapping — pick the first 3 expense accounts ───────────────────
  const expenseAccts = (await sql`
    SELECT id, account_code FROM gl_accounts
     WHERE company_id = ${COMPANY_ID}::uuid AND account_type = 'expense' AND is_active = true
     ORDER BY account_code
     LIMIT 3
  `) as Array<{ id: string; account_code: string }>;
  if (expenseAccts.length >= 2) {
    await sql`
      INSERT INTO cost_centre_gl_mappings (company_id, cost_centre_id, expense_account_id, created_by)
      VALUES
        (${COMPANY_ID}::uuid, ${centreByCode.ADMIN}::uuid, ${expenseAccts[0]!.id}::uuid, ${ADMIN_ID}),
        (${COMPANY_ID}::uuid, ${centreByCode.OPS}::uuid, ${expenseAccts[1]!.id}::uuid, ${ADMIN_ID})
    `;
    console.log(`[gl-mappings] ADMIN → ${expenseAccts[0]!.account_code}, OPS → ${expenseAccts[1]!.account_code} (SALES unmapped → fallback)`);
  }

  // ── Employees list (use demo seed's 10) + per-employee Phase 5 attrs ──
  const emps = (await sql`
    SELECT id, employee_number, first_name, last_name
      FROM payroll_employees
     WHERE company_id = ${COMPANY_ID}::uuid AND status = 'active'
     ORDER BY employee_number
  `) as Array<{ id: string; employee_number: string; first_name: string; last_name: string }>;
  console.log(`[employees] ${emps.length} active employees found`);
  if (emps.length < 4) {
    console.error('Need at least 4 demo employees. Run seed-payroll-data.ts first.');
    process.exit(1);
  }

  // Point first 3 employees at single centres, leave the rest unassigned (NULL)
  await sql`UPDATE payroll_employees SET cost_centre_id = ${centreByCode.ADMIN}::uuid WHERE id = ${emps[0]!.id}::uuid`;
  await sql`UPDATE payroll_employees SET cost_centre_id = ${centreByCode.OPS}::uuid   WHERE id = ${emps[1]!.id}::uuid`;
  await sql`UPDATE payroll_employees SET cost_centre_id = ${centreByCode.SALES}::uuid WHERE id = ${emps[2]!.id}::uuid`;

  // Employee #4 gets a 60/40 split across ADMIN and OPS
  await sql`
    INSERT INTO payroll_employee_cost_allocations (company_id, employee_id, cost_centre_id, percentage, created_by)
    VALUES
      (${COMPANY_ID}::uuid, ${emps[3]!.id}::uuid, ${centreByCode.ADMIN}::uuid, 60.00, ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, ${emps[3]!.id}::uuid, ${centreByCode.OPS}::uuid,   40.00, ${ADMIN_ID})
  `;
  console.log(`[allocations] ${emps[3]!.first_name} ${emps[3]!.last_name} → 60% ADMIN / 40% OPS`);

  // Employee #5 = cash-paid
  if (emps[4]) {
    await sql`UPDATE payroll_employees SET payment_method = 'cash' WHERE id = ${emps[4].id}::uuid`;
    console.log(`[payment-method] ${emps[4].first_name} ${emps[4].last_name} → cash`);
  }

  // ── Pay scales ────────────────────────────────────────────────────────
  const scaleRows = (await sql`
    INSERT INTO pay_scales (company_id, code, name, grade_level, min_salary, mid_salary, max_salary, created_by)
    VALUES
      (${COMPANY_ID}::uuid, 'G3', 'Grade 3 — Junior',     3, 15000, 20000, 25000, ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, 'G5', 'Grade 5 — Mid',        5, 30000, 40000, 50000, ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, 'G7', 'Grade 7 — Senior',     7, 60000, 80000, 100000, ${ADMIN_ID})
    RETURNING id, code
  `) as Array<{ id: string; code: string }>;
  const scaleByCode = Object.fromEntries(scaleRows.map(r => [r.code, r.id]));
  console.log(`[pay-scales] ${scaleRows.length} scales created`);

  await sql`UPDATE payroll_employees SET pay_scale_id = ${scaleByCode.G5}::uuid WHERE id = ${emps[0]!.id}::uuid`;
  await sql`UPDATE payroll_employees SET pay_scale_id = ${scaleByCode.G3}::uuid WHERE id = ${emps[1]!.id}::uuid`;
  await sql`UPDATE payroll_employees SET pay_scale_id = ${scaleByCode.G7}::uuid WHERE id = ${emps[2]!.id}::uuid`;

  // ── Pay package — reuses the demo's existing components ──────────────
  const components = (await sql`
    SELECT id, name FROM payroll_components WHERE company_id = ${COMPANY_ID}::uuid ORDER BY name
  `) as Array<{ id: string; name: string }>;
  if (components.length >= 2) {
    const [pkg] = (await sql`
      INSERT INTO pay_packages (company_id, code, name, description, created_by)
      VALUES (${COMPANY_ID}::uuid, 'STANDARD', 'Standard Employee Package', 'Basic salary + travel allowance bundle for regular full-time hires', ${ADMIN_ID})
      RETURNING id
    `) as Array<{ id: string }>;
    const first = components[0]!;
    const second = components[1]!;
    await sql`
      INSERT INTO pay_package_components (package_id, component_id, amount, is_recurring)
      VALUES
        (${pkg!.id}::uuid, ${first.id}::uuid, 25000, true),
        (${pkg!.id}::uuid, ${second.id}::uuid, 3000, true)
    `;
    console.log(`[pay-packages] STANDARD — ${first.name} R25k + ${second.name} R3k`);
  }

  // ── Equity backfill — assign occupational levels + demographics ─────
  const levels = (await sql`
    SELECT id, code FROM occupational_levels WHERE code IN ('top_management','senior_management','prof_qualified','skilled_technical','semi_skilled')
  `) as Array<{ id: string; code: string }>;
  const levelByCode = Object.fromEntries(levels.map(l => [l.code, l.id]));

  const races = ['african', 'white', 'coloured', 'indian', 'african', 'white', 'foreign', 'african', 'coloured', 'african'] as const;
  const genders = ['female', 'male', 'female', 'male', 'male', 'female', 'female', 'male', 'female', 'male'] as const;
  const levelCodes = ['senior_management','prof_qualified','senior_management','skilled_technical','semi_skilled','prof_qualified','skilled_technical','semi_skilled','skilled_technical','semi_skilled'] as const;
  const disabilityFlags = [false, false, true, false, false, false, false, false, false, false] as const;
  const foreignFlags = [false, false, false, false, false, false, true, false, false, false] as const;

  for (let i = 0; i < emps.length && i < races.length; i++) {
    const race = races[i]!;
    const gender = genders[i]!;
    const levelId = levelByCode[levelCodes[i]!];
    if (!levelId) continue;
    await sql`
      UPDATE payroll_employees SET
        equity_race = ${race}::varchar,
        equity_gender = ${gender}::varchar,
        equity_disability = ${disabilityFlags[i]!}::boolean,
        is_foreign_national = ${foreignFlags[i]!}::boolean,
        occupational_level_id = ${levelId}::uuid
       WHERE id = ${emps[i]!.id}::uuid
    `;
  }
  console.log(`[equity] 10 employees tagged with race/gender/disability/foreign/occupational-level`);

  // ── Training events ──────────────────────────────────────────────────
  await sql`
    INSERT INTO training_events
      (company_id, employee_id, category, description, provider, nqf_level,
       planned_start, planned_end, cost_planned, cost_actual, status, created_by)
    VALUES
      (${COMPANY_ID}::uuid, ${emps[0]!.id}::uuid, 'short_course', 'Advanced Excel for Finance Teams',
         'Koenig Solutions', 5, '2026-05-12', '2026-05-16', 8500, 8500, 'completed', ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, ${emps[1]!.id}::uuid, 'learnership',  'Business Administration NQF 4',
         'Services SETA Provider', 4, '2026-03-01', '2026-11-30', 42000, 18000, 'in_progress', ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, ${emps[2]!.id}::uuid, 'bursary',      'B.Com Accounting (Part-time)',
         'UNISA', 7, '2026-02-01', '2026-11-30', 45000, 22000, 'in_progress', ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, ${emps[3]!.id}::uuid, 'workshop',     'Leadership Fundamentals',
         'USB Executive Development', 6, '2026-06-10', '2026-06-11', 4500, 0, 'planned', ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, ${emps[4]!.id}::uuid, 'aet',          'AET Level 4 — Literacy',
         'Edge Learning Media', 1, '2026-04-01', '2026-10-31', 12000, 4000, 'in_progress', ${ADMIN_ID})
  `;
  console.log('[training-events] 5 events seeded (short course, learnership, bursary, workshop, AET)');

  // ── Seed one historical change so the timeline has content ──────────
  await sql`
    INSERT INTO payroll_employee_history
      (company_id, employee_id, field_name, old_value, new_value, effective_from, change_reason, changed_by)
    VALUES
      (${COMPANY_ID}::uuid, ${emps[0]!.id}::uuid, 'employment_type', 'contract', 'permanent',
         '2026-01-01', 'Converted to permanent after probation', ${ADMIN_ID}),
      (${COMPANY_ID}::uuid, ${emps[1]!.id}::uuid, 'cost_centre_id',  NULL, ${centreByCode.OPS},
         '2026-03-01', 'Moved from Unassigned to Operations', ${ADMIN_ID})
  `;
  console.log('[history] 2 timeline entries seeded');

  console.log('\n=== Phase 5 seeding complete ===');
  await closeSql();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  try { await closeSql(); } catch {}
  process.exit(1);
});
