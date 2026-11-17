/**
 * An employee's payslip address (wave 6 PE, migration 999o: payroll_employees.email).
 *
 * `judgeEmployeeEmail` accepts one plain address or a blank (which clears it), and refuses anything else before any
 * write: more than 254 characters, not exactly one '@', a dot-less domain, or any space, comma, semicolon, angle
 * bracket, quote, parenthesis, square bracket, backslash or control character. So a stored value can never name a
 * second recipient or carry a header. The 999o CHECK holds the same rule in the database.
 *
 * `setEmployeeEmail` writes it on this company's employee only and records one audit_log `update` row with the
 * before and after; an unchanged value writes nothing. It returns null when the employee is not this company's.
 */
import { sql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';

const PART = String.raw`[^@\s,;<>"()\[\]\\\u0000-\u001f\u007f]+`;
const EMAIL = new RegExp(`^${PART}@${PART}\\.${PART}$`);
const MAX = 254;

export class EmployeeEmailRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeEmailRefused';
  }
}

/** The address to store (trimmed), or null for a blank. Throws EmployeeEmailRefused for anything else. */
export function judgeEmployeeEmail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new EmployeeEmailRefused('email must be text or null');
  const v = value.trim();
  if (v === '') return null;
  if (v.length > MAX) throw new EmployeeEmailRefused(`The email address must be at most ${MAX} characters.`);
  if (!EMAIL.test(v)) throw new EmployeeEmailRefused('Enter one email address, like name@example.co.za.');
  return v;
}

export interface EmployeeEmailActor { userId: string; userEmail?: string; ip?: string; userAgent?: string; sessionId?: string | null }

/** This company's employee's address; undefined when the employee is not this company's. */
export async function readEmployeeEmail(companyId: string, employeeId: string): Promise<string | null | undefined> {
  const rows = (await sql`
    SELECT email FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as Array<{ email: string | null }>;
  return rows.length === 0 ? undefined : rows[0]!.email;
}

export async function setEmployeeEmail(
  companyId: string, employeeId: string, email: string | null, actor: EmployeeEmailActor,
): Promise<{ email: string | null } | null> {
  const before = (await sql`
    SELECT email FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
  `) as Array<{ email: string | null }>;
  if (before.length === 0) return null;
  const old = before[0]!.email;
  if (old === email) return { email };
  await sql`
    UPDATE payroll_employees SET email = ${email}, updated_at = now()
     WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `;
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_employee',
    entityId: employeeId, changes: { fields: [{ field: 'email', old, new: email, label: 'Payslip email' }] },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  return { email };
}
