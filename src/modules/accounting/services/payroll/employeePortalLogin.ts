/**
 * The employee's side of a portal login (wave 6 SS): accept an invitation (choose a password) and sign in.
 *
 * Both read and write employee_portal_access on migration_admin only (no app role may read password_hash or the
 * invite token hash, 999u), from fixed statements; bcrypt runs between transactions, holding none of that pool's
 * connections, as the AR portal login does (portalService.authenticatePortalUser). The routes rate-limit both before
 * they get here (the brute-force limit is the route's).
 *
 * Sign-in judges the password FIRST and says nothing else to a caller who has not proved it: a wrong password, an
 * unknown address and a revoked login all answer null. Only then: the platform switch, the company setting and a live
 * company (portalClosedReason), and the leaver window (ACCESS_ENDED). One address may hold logins at several
 * employers; when the password opens more than one, the caller must pick (`choose`), naming only those employers.
 */
import bcrypt from 'bcryptjs';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import type { EmployeePortalClaims } from '@/lib/auth/employeePortalJwt';
import { EmployeePortalRefusal } from './employeePortalRefusal';
import { portalClosedReason } from './employeePortalSettings';
import { portalAccessOpen } from './employeePortalWindow';
import { inviteTokenHash } from './employeePortalAccess';

const BCRYPT_COST = 12;
export const PASSWORD_MIN = 10;
/** bcrypt reads at most 72 bytes; a longer password would be cut silently. */
export const PASSWORD_MAX_BYTES = 72;
const MAX_CANDIDATES = 5;
/** Compared against when no login has the address, so an unknown address takes as long as a wrong password. */
let dummyHash: string | null = null;

interface LoginRow {
  id: string; company_id: string; employee_id: string; password_hash: string | null; session_version: number;
  status: string; end_date: string | null; employer: string;
}

const LOGIN_SELECT = `
  SELECT a.id, a.company_id, a.employee_id, a.password_hash, a.session_version, e.status, e.end_date, c.name AS employer
    FROM employee_portal_access a
    JOIN payroll_employees e ON e.id = a.employee_id AND e.company_id = a.company_id
    JOIN companies c ON c.id = a.company_id`;

async function admitted(row: LoginRow): Promise<EmployeePortalClaims> {
  const closed = await portalClosedReason(row.company_id);
  if (closed) throw new EmployeePortalRefusal(closed, 'The employee portal is not available for this employer.');
  if (!portalAccessOpen({ status: row.status, endDate: row.end_date })) {
    throw new EmployeePortalRefusal('ACCESS_ENDED', 'Your access to this employer\'s portal has ended.');
  }
  return { accessId: row.id, companyId: row.company_id, employeeId: row.employee_id, sessionVersion: Number(row.session_version) };
}

export function judgePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new EmployeePortalRefusal('WEAK_PASSWORD', `Choose a password of at least ${PASSWORD_MIN} characters (at most ${PASSWORD_MAX_BYTES} bytes).`);
  }
  return password;
}

export type SignInResult =
  | { kind: 'signed_in'; claims: EmployeePortalClaims }
  | { kind: 'choose'; employers: Array<{ accessId: string; employer: string }> }
  | { kind: 'refused' };

export async function signInEmployee(email: string, password: string, accessId?: string): Promise<SignInResult> {
  const rows = await migrationAdminTx('employee portal login lookup', async (client) => (await client.query(
    `${LOGIN_SELECT} WHERE lower(a.email) = lower($1) AND a.status = 'active' ORDER BY a.activated_at, a.id LIMIT ${MAX_CANDIDATES}`,
    [email],
  )).rows as LoginRow[]);
  if (rows.length === 0) await bcrypt.compare(password, dummyHash ??= await bcrypt.hash('employee-portal-timing', BCRYPT_COST));
  const matches: LoginRow[] = [];
  for (const row of rows) {
    if (row.password_hash && await bcrypt.compare(password, row.password_hash)) matches.push(row);
  }
  const chosen = accessId === undefined ? matches : matches.filter((m) => m.id === accessId);
  if (chosen.length === 0) return { kind: 'refused' };
  if (chosen.length > 1) return { kind: 'choose', employers: chosen.map((m) => ({ accessId: m.id, employer: m.employer })) };
  const claims = await admitted(chosen[0]!);
  await migrationAdminTx('employee portal login stamp', (client) => client.query(
    'UPDATE employee_portal_access SET last_login_at = now() WHERE id = $1::uuid AND status = \'active\'', [claims.accessId],
  ));
  return { kind: 'signed_in', claims };
}

/** Accepts an invitation: the password becomes the login's, the token is spent, and the employee is signed in. */
export async function acceptEmployeeInvite(token: string, password: string): Promise<EmployeePortalClaims> {
  const hash = inviteTokenHash(token);
  const invalid = () => new EmployeePortalRefusal('INVITE_INVALID', 'This invitation link is not valid any more. Ask your employer to invite you again.');
  const row = (await migrationAdminTx('employee portal invite lookup', async (client) => (await client.query(
    `${LOGIN_SELECT} WHERE a.invite_token_hash = $1 AND a.status = 'invited' AND a.invite_expires_at > now()`, [hash],
  )).rows as LoginRow[]))[0];
  if (!row) throw invalid();
  await admitted(row);
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const done = await migrationAdminTx('employee portal invite accept', async (client) => (await client.query(
    `UPDATE employee_portal_access
        SET status = 'active', password_hash = $3, activated_at = now(), last_login_at = now(),
            invite_token_hash = NULL, invite_expires_at = NULL, updated_at = now()
      WHERE id = $1::uuid AND status = 'invited' AND invite_token_hash = $2 AND invite_expires_at > now()
      RETURNING session_version`,
    [row.id, hash, passwordHash],
  )).rows as Array<{ session_version: number }>);
  if (!done[0]) throw invalid();
  return { accessId: row.id, companyId: row.company_id, employeeId: row.employee_id, sessionVersion: Number(done[0].session_version) };
}
