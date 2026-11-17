/**
 * Whether a company may email payslips (wave 6 PE). Two switches, both off by default:
 *   - the platform switch `payroll_payslip_email` (feature_flags, 999a; spec rule 20): only a platform admin turns
 *     it on, for a company or for all. It is checked FIRST, so a client owner or admin can never make a company's
 *     first live send on their own (grill F7; ruling 8: the first live send is Hein's);
 *   - the company setting `payroll_company_settings.payslip_email_enabled` (999a; F27), which an owner or admin
 *     sets here. No row means off. Each change writes one audit_log `update` row; an unchanged value writes nothing.
 *     updated_by / updated_at are the table's stamp trigger's (999i), never written here.
 */
import { sql } from '@/lib/neon';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export const PAYSLIP_EMAIL_FLAG = 'payroll_payslip_email';

export interface PayslipEmailState {
  /** The platform switch for this company. Off: nothing can be sent, whatever the company setting says. */
  platformEnabled: boolean;
  /** The company's own setting. */
  enabled: boolean;
}

export async function companyPayslipEmailEnabled(companyId: string, lock = false): Promise<boolean> {
  const rows = (lock
    ? await sql`SELECT payslip_email_enabled FROM payroll_company_settings WHERE company_id = ${companyId}::uuid FOR UPDATE`
    : await sql`SELECT payslip_email_enabled FROM payroll_company_settings WHERE company_id = ${companyId}::uuid`
  ) as Array<{ payslip_email_enabled: boolean }>;
  return rows[0]?.payslip_email_enabled === true;
}

export async function readPayslipEmailState(companyId: string): Promise<PayslipEmailState> {
  const platformEnabled = await hasFeature(companyId, PAYSLIP_EMAIL_FLAG);
  return { platformEnabled, enabled: await companyPayslipEmailEnabled(companyId) };
}

export async function setPayslipEmailEnabled(
  companyId: string, enabled: boolean, actor: EmployeeEmailActor,
): Promise<PayslipEmailState> {
  const before = await companyPayslipEmailEnabled(companyId, true);
  if (before !== enabled) {
    await sql`
      INSERT INTO payroll_company_settings (company_id, payslip_email_enabled)
      VALUES (${companyId}::uuid, ${enabled})
      ON CONFLICT (company_id) DO UPDATE SET payslip_email_enabled = EXCLUDED.payslip_email_enabled
    `;
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_company_settings',
      entityId: companyId,
      changes: { fields: [{ field: 'payslip_email_enabled', old: String(before), new: String(enabled), label: 'Email payslips' }] },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    });
  }
  return readPayslipEmailState(companyId);
}
