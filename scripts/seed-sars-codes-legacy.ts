/**
 * Backfill 2024 + 2025 SARS source codes from the legacy hardcoded map
 * (src/modules/accounting/services/reports/irp5Service.ts SARS_SOURCE_CODES).
 *
 * Marked clearly as a minimal seed — replace with the official annual guides
 * (PAYE-AE-06-G06 2024 + 2025) when available. Allows historical IRP5
 * regeneration to look up codes by year without breaking.
 */

import { createSql, closeSql } from './_pg';

interface Seed {
  code: string;
  description: string;
  category: 'income' | 'allowance' | 'fringe' | 'employer' | 'deduction' | 'lump_sum';
}

const LEGACY_CODES: Seed[] = [
  { code: '3601', description: 'Gross salary/wages', category: 'income' },
  { code: '3605', description: 'Annual bonus', category: 'income' },
  { code: '3701', description: 'Travel allowance (taxable portion 80%)', category: 'allowance' },
  { code: '3702', description: 'Reimbursive travel allowance — taxable', category: 'allowance' },
  { code: '3703', description: 'Reimbursive travel allowance — non-taxable', category: 'allowance' },
  { code: '3713', description: 'Other allowances (taxable)', category: 'allowance' },
  { code: '3801', description: 'General fringe benefits', category: 'fringe' },
  { code: '3802', description: 'Right of use of motor vehicle', category: 'fringe' },
  { code: '3810', description: 'Medical aid contribution paid by employer', category: 'fringe' },
  { code: '3815', description: 'Bursaries / scholarships', category: 'fringe' },
  { code: '4001', description: 'Pension fund contributions (employee)', category: 'deduction' },
  { code: '4002', description: 'Provident fund contributions (employee)', category: 'deduction' },
  { code: '4003', description: 'Medical aid contributions (employee)', category: 'deduction' },
  { code: '4004', description: 'Retirement annuity contributions', category: 'deduction' },
  { code: '4005', description: 'Donations (Section 18A)', category: 'deduction' },
  { code: '4102', description: 'PAYE (Pay As You Earn)', category: 'deduction' },
  { code: '4141', description: 'UIF contributions (employee)', category: 'deduction' },
  { code: '4142', description: 'UIF contributions (employer)', category: 'employer' },
  { code: '4150', description: 'SDL (Skills Development Levy)', category: 'employer' },
];

const SEED_NOTE = 'ISAFlow legacy seed (replace with official PAYE-AE-06-G06 when available)';

async function seedYear(year: number): Promise<void> {
  const sql = createSql();
  let inserted = 0;
  let skipped = 0;

  for (const c of LEGACY_CODES) {
    const existing = await sql<{ code: string }>`
      SELECT code FROM sars_source_codes
       WHERE code = ${c.code} AND effective_year = ${year}
    `;
    if (existing.length > 0) {
      skipped++;
      continue;
    }
    await sql`
      INSERT INTO sars_source_codes (
        code, effective_year, category, description, status,
        source_document, brs_version
      ) VALUES (
        ${c.code}, ${year}, ${c.category}, ${c.description}, 'active',
        ${SEED_NOTE}, 'legacy'
      )
    `;
    inserted++;
  }

  await sql`
    INSERT INTO sars_code_releases (effective_year, brs_version, released_at, is_current, notes)
    VALUES (${year}, 'legacy', now(), false, ${SEED_NOTE})
    ON CONFLICT (effective_year) DO NOTHING
  `;

  console.log(`Year ${year}: inserted ${inserted}, skipped ${skipped} (already present).`);
}

async function main(): Promise<void> {
  await seedYear(2024);
  await seedYear(2025);
  // Top up 2026 with the 4xxx deduction/employer codes (SARS PAYE-AE-06-G06
  // master XLSX only covers 3xxx income/allowance/fringe codes — the 4xxx
  // codes aren't in the source spreadsheet but our payroll engine needs them).
  await seedYear(2026);
  await closeSql();
}

main().catch(async (err) => {
  console.error(err);
  await closeSql();
  process.exit(1);
});
