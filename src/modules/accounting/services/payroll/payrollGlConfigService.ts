import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export type PayrollGlRole =
  | 'salaries_expense'
  | 'net_salaries_payable'
  | 'paye_payable'
  | 'uif_payable'
  | 'sdl_payable'
  | 'uif_employer_expense'
  | 'sdl_employer_expense';

export const PAYROLL_GL_ROLES: readonly PayrollGlRole[] = [
  'salaries_expense',
  'net_salaries_payable',
  'paye_payable',
  'uif_payable',
  'sdl_payable',
  'uif_employer_expense',
  'sdl_employer_expense',
];

export interface PayrollGlMapping {
  role: PayrollGlRole;
  glAccountId: string;
}

export async function getPayrollGlMappings(companyId: string): Promise<PayrollGlMapping[]> {
  const rows = (await sql`
    SELECT role, gl_account_id FROM payroll_gl_accounts
    WHERE company_id = ${companyId}::uuid
    ORDER BY role
  `) as Row[];
  return rows.map(r => ({
    role: String(r.role) as PayrollGlRole,
    glAccountId: String(r.gl_account_id),
  }));
}

export async function upsertPayrollGlMappings(
  companyId: string,
  mappings: PayrollGlMapping[],
): Promise<PayrollGlMapping[]> {
  log.info('Upserting payroll GL mappings', { companyId, count: mappings.length }, 'payrollGlConfigService');
  for (const m of mappings) {
    if (!PAYROLL_GL_ROLES.includes(m.role)) {
      throw new Error(`Unknown payroll GL role: ${m.role}`);
    }
    if (m.glAccountId === '') {
      await sql`
        DELETE FROM payroll_gl_accounts
        WHERE company_id = ${companyId}::uuid AND role = ${m.role}
      `;
    } else {
      await sql`
        INSERT INTO payroll_gl_accounts (company_id, role, gl_account_id)
        VALUES (${companyId}::uuid, ${m.role}, ${m.glAccountId}::uuid)
        ON CONFLICT (company_id, role) DO UPDATE
        SET gl_account_id = EXCLUDED.gl_account_id, updated_at = NOW()
      `;
    }
  }
  return getPayrollGlMappings(companyId);
}

export async function getCompletePayrollGlMappings(
  companyId: string,
): Promise<Record<PayrollGlRole, string>> {
  const rows = await getPayrollGlMappings(companyId);
  const map: Partial<Record<PayrollGlRole, string>> = {};
  for (const r of rows) map[r.role] = r.glAccountId;
  const missing = PAYROLL_GL_ROLES.filter(role => !map[role]);
  if (missing.length > 0) {
    throw new Error(
      `Payroll GL mapping incomplete — missing: ${missing.join(', ')}. Configure at /payroll/settings.`,
    );
  }
  return map as Record<PayrollGlRole, string>;
}
