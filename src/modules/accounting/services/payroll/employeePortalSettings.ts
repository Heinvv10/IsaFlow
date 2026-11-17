/**
 * Whether a company's employees may use the self-service portal (wave 6 SS). Two switches, both off by default:
 *   - the platform switch `payroll_employee_portal` (feature_flags, 999a; spec rule 20): only a platform admin turns
 *     it on. It is checked FIRST, on every invite, login and portal request, so a client owner or admin can never
 *     open the portal on their own (grill F7; the first live invite is Hein's);
 *   - the company setting `payroll_company_settings.employee_portal_enabled` (999a; F27), set here by an owner or
 *     admin. No row means off. Each change writes one audit_log `update` row; an unchanged value writes nothing.
 * `portalClosedReason` is the one judgement every path uses: the two switches, then the company being live.
 */
import { sql } from '@/lib/neon';
import { listLiveCompanies } from '@/lib/auth/liveCompanies';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export const EMPLOYEE_PORTAL_FLAG = 'payroll_employee_portal';

export interface EmployeePortalState { platformEnabled: boolean; enabled: boolean }

async function companySetting(companyId: string, lock = false): Promise<boolean> {
  const rows = (lock
    ? await sql`SELECT employee_portal_enabled FROM payroll_company_settings WHERE company_id = ${companyId}::uuid FOR UPDATE`
    : await sql`SELECT employee_portal_enabled FROM payroll_company_settings WHERE company_id = ${companyId}::uuid`
  ) as Array<{ employee_portal_enabled: boolean }>;
  return rows[0]?.employee_portal_enabled === true;
}

export async function readEmployeePortalState(companyId: string): Promise<EmployeePortalState> {
  return { platformEnabled: await hasFeature(companyId, EMPLOYEE_PORTAL_FLAG), enabled: await companySetting(companyId) };
}

/** Why the portal is closed for this company, or null when it is open. The platform switch is judged first. */
export async function portalClosedReason(companyId: string): Promise<'FEATURE_DISABLED' | 'PORTAL_OFF' | null> {
  if (!(await hasFeature(companyId, EMPLOYEE_PORTAL_FLAG))) return 'FEATURE_DISABLED';
  if (!(await companySetting(companyId))) return 'PORTAL_OFF';
  if ((await listLiveCompanies([companyId])).length === 0) return 'PORTAL_OFF';
  return null;
}

export async function setEmployeePortalEnabled(
  companyId: string, enabled: boolean, actor: EmployeeEmailActor,
): Promise<EmployeePortalState> {
  const before = await companySetting(companyId, true);
  if (before !== enabled) {
    await sql`
      INSERT INTO payroll_company_settings (company_id, employee_portal_enabled)
      VALUES (${companyId}::uuid, ${enabled})
      ON CONFLICT (company_id) DO UPDATE SET employee_portal_enabled = EXCLUDED.employee_portal_enabled
    `;
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_company_settings',
      entityId: companyId,
      changes: { fields: [{ field: 'employee_portal_enabled', old: String(before), new: String(enabled), label: 'Employee self-service' }] },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    });
  }
  return readEmployeePortalState(companyId);
}
