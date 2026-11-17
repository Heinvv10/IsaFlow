/**
 * The employer's side of an employee's portal login (wave 6 SS, migration 999u): read it, invite, revoke.
 *
 * Invite is judged in full before any write or send (rule 12), in this order: the platform switch (FEATURE_DISABLED,
 * rule 20 / F7), the company setting (PORTAL_OFF), this company's employee (NOT_FOUND), an address on file (NO_EMAIL;
 * PE's payroll_employees.email, which only an owner or admin sets), the employee still within access (ACCESS_ENDED:
 * a leaver past the end of the next tax year), not already active (ALREADY_ACTIVE: revoke first), then the send
 * limit. The login row is then written on migration_admin (no app role writes the table, 937's rule), with only the
 * sha256 of a fresh 256-bit token, valid 7 days; any earlier invite's token stops working. The link carries the token
 * in the URL FRAGMENT, so it never reaches a server log or analytics. The mail goes through the injected Mailer
 * (rule 11; the route passes sendEmail, tests a capture mailer). A failed send is reported (`sent: false`), not
 * thrown, so the audit row commits; inviting again issues a new link.
 *
 * Revoke ends the login and, through session_version, every session already signed in.
 */
import { createHash, randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { escapeHtml } from '@/modules/accounting/services/packs/escapeHtml';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import type { Mailer } from './payslipDeliveryService';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';
import { EmployeePortalRefusal } from './employeePortalRefusal';
import { portalClosedReason } from './employeePortalSettings';
import { portalAccessEnds, portalAccessOpen } from './employeePortalWindow';

export const INVITE_TTL_DAYS = 7;
const appOrigin = () => (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za').replace(/\/+$/, '');
const SEND = { smtpTimeoutsMs: { connection: 5_000, greeting: 5_000, socket: 10_000 }, deadlineMs: 15_000 };

export interface EmployeePortalAccessView {
  status: 'none' | 'invited' | 'active' | 'revoked';
  email: string | null;
  invitedAt: string | null;
  inviteExpiresAt: string | null;
  activatedAt: string | null;
  lastLoginAt: string | null;
  /** The last day a leaver may sign in; null = no limit; 'closed' = may not sign in. */
  accessEnds: string | null | 'closed';
}

interface EmployeeRow { first_name: string; email: string | null; status: string; end_date: string | null }

async function employee(companyId: string, employeeId: string): Promise<EmployeeRow | null> {
  const rows = (await sql`
    SELECT first_name, email, status, end_date FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as EmployeeRow[];
  return rows[0] ?? null;
}

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** The login as the employer sees it; null when the employee is not this company's. */
export async function readEmployeePortalAccess(companyId: string, employeeId: string): Promise<EmployeePortalAccessView | null> {
  const emp = await employee(companyId, employeeId);
  if (!emp) return null;
  const row = ((await sql`
    SELECT status, email, invited_at, invite_expires_at, activated_at, last_login_at
      FROM employee_portal_access WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
  `) as Array<Record<string, unknown>>)[0];
  return {
    status: (row?.status as EmployeePortalAccessView['status']) ?? 'none',
    email: row ? String(row.email) : null,
    invitedAt: iso(row?.invited_at), inviteExpiresAt: iso(row?.invite_expires_at),
    activatedAt: iso(row?.activated_at), lastLoginAt: iso(row?.last_login_at),
    accessEnds: portalAccessEnds({ status: emp.status, endDate: emp.end_date }),
  };
}

export const inviteTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function portalInviteMessage(employerName: string, firstName: string, link: string): { subject: string; html: string } {
  return {
    subject: `Your payslip portal invitation from ${employerName}`.replace(/[\r\n]+/g, ' '),
    html: `<p>Dear ${escapeHtml(firstName)},</p>`
      + `<p>${escapeHtml(employerName)} has invited you to view your payslips and leave balance online.</p>`
      + `<p><a href="${escapeHtml(link)}">Choose your password</a>. The link works for ${INVITE_TTL_DAYS} days, once.</p>`
      + '<p>If you did not expect this email, please tell your employer and delete it.</p>',
  };
}

export interface InviteInput {
  companyId: string; employeeId: string; actor: EmployeeEmailActor; mailer: Mailer;
  /** Charges the send limit; false = RATE_LIMITED. Called last, after every other refusal. */
  admit: () => Promise<boolean>;
}

export async function inviteEmployeeToPortal(input: InviteInput): Promise<{ status: 'invited'; sent: boolean; error?: string }> {
  const { companyId, employeeId, actor } = input;
  const closed = await portalClosedReason(companyId);
  if (closed) throw new EmployeePortalRefusal(closed, closed === 'FEATURE_DISABLED'
    ? 'Employee self-service is not switched on for this company yet.' : 'Turn on employee self-service in payroll settings first.');
  const emp = await employee(companyId, employeeId);
  if (!emp) throw new EmployeePortalRefusal('NOT_FOUND', 'Employee not found');
  if (!emp.email) throw new EmployeePortalRefusal('NO_EMAIL', 'Add the employee\'s email address first.');
  if (!portalAccessOpen({ status: emp.status, endDate: emp.end_date })) {
    throw new EmployeePortalRefusal('ACCESS_ENDED', 'This employee\'s portal access has ended.');
  }
  const current = (await sql`
    SELECT status FROM employee_portal_access WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
  `) as Array<{ status: string }>;
  const already = () => new EmployeePortalRefusal('ALREADY_ACTIVE', 'This employee already uses the portal. Revoke it first to invite again.');
  if (current[0]?.status === 'active') throw already();
  if (!(await input.admit())) throw new EmployeePortalRefusal('RATE_LIMITED', 'Too many invitations. Please try again shortly.');

  const token = randomBytes(32).toString('base64url');
  const written = await migrationAdminTx('employee portal invite', async (client) => (await client.query(
    `INSERT INTO employee_portal_access (company_id, employee_id, email, status, invite_token_hash, invite_expires_at, invited_by)
     VALUES ($1::uuid, $2::uuid, $3, 'invited', $4, now() + make_interval(days => $5), $6)
     ON CONFLICT (company_id, employee_id) DO UPDATE
       SET email = EXCLUDED.email, status = 'invited', password_hash = NULL, invite_token_hash = EXCLUDED.invite_token_hash,
           invite_expires_at = EXCLUDED.invite_expires_at, invited_at = now(), invited_by = EXCLUDED.invited_by,
           activated_at = NULL, revoked_at = NULL, revoked_by = NULL,
           session_version = employee_portal_access.session_version + 1, updated_at = now()
     WHERE employee_portal_access.status <> 'active'
     RETURNING id`,
    [companyId, employeeId, emp.email, inviteTokenHash(token), INVITE_TTL_DAYS, actor.userId],
  )).rows as Array<{ id: string }>);
  if (!written[0]) throw already();

  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'create', entityType: 'employee_portal_access',
    entityId: written[0].id, changes: { fields: [{ field: 'invited', old: null, new: emp.email, label: 'Portal invitation' }] },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  const employer = ((await sql`SELECT name FROM companies WHERE id = ${companyId}::uuid`) as Array<{ name: string }>)[0]?.name ?? '';
  const link = `${appOrigin()}/employee-portal/accept#t=${token}`;
  const result = await input.mailer({ to: emp.email, ...portalInviteMessage(employer, emp.first_name, link), ...SEND });
  return result.success ? { status: 'invited', sent: true } : { status: 'invited', sent: false, error: 'The invitation email could not be sent. Invite again.' };
}

/** Ends the login and every session signed in with it. */
export async function revokeEmployeePortalAccess(companyId: string, employeeId: string, actor: EmployeeEmailActor): Promise<void> {
  if (!(await employee(companyId, employeeId))) throw new EmployeePortalRefusal('NOT_FOUND', 'Employee not found');
  const done = await migrationAdminTx('employee portal revoke', async (client) => (await client.query(
    `UPDATE employee_portal_access
        SET status = 'revoked', revoked_at = now(), revoked_by = $3, password_hash = NULL, invite_token_hash = NULL,
            session_version = session_version + 1, updated_at = now()
      WHERE company_id = $1::uuid AND employee_id = $2::uuid AND status <> 'revoked'
      RETURNING id`,
    [companyId, employeeId, actor.userId],
  )).rows as Array<{ id: string }>);
  if (!done[0]) throw new EmployeePortalRefusal('NO_ACCESS', 'This employee has no portal access to revoke.');
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'delete', entityType: 'employee_portal_access',
    entityId: done[0].id, changes: { fields: [{ field: 'status', old: 'invited/active', new: 'revoked', label: 'Portal access' }] },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
}
