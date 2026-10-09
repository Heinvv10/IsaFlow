/**
 * Bank controls (forensic-controls step 2; Hein's decisions 2026-10-09) — the
 * pieces every bank control shares, kept free of any import from the approval
 * kernel so approvalEnforcement.ts can use them without a cycle: the typed
 * refusal, "a person in their own session", and R-035 Q2's sole-approver test
 * judged on the ADMIN FLOOR (no OTHER active member reaches admin), exactly as
 * step 1 judges a setter (supplierBankVerifiers.ts).
 */
import { sql } from '@/lib/neon';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { actorRank, requiredRank } from '../gl/approvalRank';

/** The floor of every bank control's role: R-035's default approver role. */
export const BANK_CONTROL_FLOOR = 'admin';

export type BankControlRefusalCode =
  | 'IMPERSONATION_FORBIDDEN' | 'AGENT_FORBIDDEN' | 'IMPORTER_MAY_NOT_ALLOCATE' | 'ALLOCATOR_MAY_NOT_REVERSE'
  | 'APPROVER_ROLE_REQUIRED' | 'PROPOSER_MAY_NOT_DECIDE' | 'WEAKENING_REQUIRES_AUTHORITY'
  | 'RULE_CHANGED' | 'CHANGE_NOT_PENDING' | 'DIGEST_MISMATCH' | 'RULE_MERGE_HELD' | 'NOT_FOUND';

const STATUS: Record<BankControlRefusalCode, 403 | 404 | 409> = {
  IMPERSONATION_FORBIDDEN: 403, AGENT_FORBIDDEN: 403, IMPORTER_MAY_NOT_ALLOCATE: 403, ALLOCATOR_MAY_NOT_REVERSE: 403,
  APPROVER_ROLE_REQUIRED: 403, PROPOSER_MAY_NOT_DECIDE: 403, WEAKENING_REQUIRES_AUTHORITY: 403,
  RULE_CHANGED: 409, CHANGE_NOT_PENDING: 409, DIGEST_MISMATCH: 409, RULE_MERGE_HELD: 409, NOT_FOUND: 404,
};

/** A refusal by a bank control. Raised before anything is written. */
export class BankControlError extends Error {
  readonly status: 403 | 404 | 409;
  constructor(readonly code: BankControlRefusalCode, message: string) {
    super(message);
    this.name = 'BankControlError';
    this.status = STATUS[code];
  }
}

/**
 * A bank control's decision (approving a rule change, switching a control,
 * weakening auto-post, reversing under enforcement) is made by a person in
 * their own cookie session. "Login as" is refused, and so is a context that
 * cannot show it is not one — an MCP tool or a job carries no session id
 * (`unknown`): agents may propose, never decide (R-035 Q6).
 */
export async function assertHumanSession(action: string): Promise<void> {
  const actor = await currentSessionActor();
  if (actor === 'self') return;
  if (actor === 'impersonation') {
    throw new BankControlError('IMPERSONATION_FORBIDDEN',
      `You cannot ${action} while impersonating another user. End the impersonation and act as yourself.`);
  }
  throw new BankControlError('AGENT_FORBIDDEN', `Only a person signed in as themselves can ${action}; an agent or a job cannot.`);
}

/** Whether this request is a person in their own session — a UI hint; the write decides. */
export async function isHumanSession(): Promise<boolean> {
  return (await currentSessionActor()) === 'self';
}

type Member = { user_id: string; role: string; is_active: boolean | null; status: string | null; suspended_at: string | null };

/**
 * The OTHER active members of the company (the roster R-035 Q2 judges on),
 * through the SECURITY DEFINER approval_company_other_members, which answers
 * only for the request's own user and company.
 */
export async function otherActiveMembers(companyId: string, userId: string): Promise<{ userId: string; role: string }[]> {
  const rows = (await sql`
    SELECT m.user_id, m.role, m.is_active, m.status, m.suspended_at
    FROM approval_company_other_members(${companyId}::UUID, ${userId}::TEXT) m
  `) as Member[];
  return rows.filter((m) => isActiveUserAccount(m)).map((m) => ({ userId: String(m.user_id), role: String(m.role) }));
}

/** R-035 Q2 on the admin floor: no OTHER active member of the company reaches admin. */
export async function isSoleAtFloor(companyId: string, userId: string): Promise<boolean> {
  const others = await otherActiveMembers(companyId, userId);
  return !others.some((m) => actorRank(m.role) >= requiredRank(BANK_CONTROL_FLOOR));
}

/** 708's roster snapshot, as the 877 guards re-read it for a sole approver's decision. */
export async function rosterSnapshot(companyId: string, userId: string): Promise<unknown> {
  const rows = (await sql`SELECT approval_roster_snapshot(${companyId}::UUID, ${userId}::TEXT) AS roster`) as { roster: unknown }[];
  return rows[0]?.roster ?? null;
}
