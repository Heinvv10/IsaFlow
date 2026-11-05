/**
 * Who may move a system role through the chart-of-accounts import, and the audit of the move.
 *
 * The import's `systemAccountMap` moves roles exactly as the Default Accounts save does, but its route is open to every
 * writer (manager included) and wrote no audit row. With `payroll_net_pay` unset payroll credits net pay to the BANK-role
 * holder, so a manager who moved the bank role here redirected net pay past the owner/admin gate on Default Accounts
 * (review round 2). So: the import refuses a manager (403) when the bank holder would actually CHANGE (a map that names
 * the account already holding the role, or no `bank` key, is not a move and is not gated), and any role it moves is
 * audited in the same transaction with the same row Default Accounts writes.
 *
 * An import with no `actor` (a script or test calling the service directly) is neither gated nor audited: only the route
 * is a request path, and it always passes one.
 */
import { sql } from '@/lib/neon';
import { TransactionRefusal } from '@/lib/transactionRefusal';
import { canSetPayrollNetPay } from '@/lib/auth/writeRoles';
import { DEFAULT_ACCOUNT_ROLES } from '../gl/defaultAccountRoles';
import { auditDefaultAccountChanges, type DefaultAccountChange } from '../gl/defaultAccountsAudit';
import type { RoleSnapshot } from '../gl/systemRoleInvariant';

export interface CoaImportActor {
  role: string | null | undefined;
  userId: string;
}

/** A role the import's map would re-point: the holder before (null = none) and the code it names. */
export interface RoleMove {
  subtype: string;
  fromId: string | null;
  toCode: string;
}

/** 403: a role without owner/admin may not move the bank role. Thrown before any write. */
export class CoaRoleChangeForbiddenError extends TransactionRefusal {}

/** The UI key that manages a role (`bank` -> `primary_bank`), else the role's own name. */
const uiKeyOf = (subtype: string): string => Object.entries(DEFAULT_ACCOUNT_ROLES).find(([, role]) => role === subtype)?.[0] ?? subtype;

/** The roles in `map` that the import would actually move, judged on the snapshot taken inside the role lock. */
export async function roleMapMoves(companyId: string, roles: RoleSnapshot, map: Record<string, unknown>): Promise<RoleMove[]> {
  const named = Object.entries(map).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '');
  if (named.length === 0) return [];
  const rows = (await sql`
    SELECT account_code, id::TEXT AS id FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ANY(${named.map(([, code]) => code)}::TEXT[])
  `) as Array<{ account_code: string; id: string }>;
  const idOfCode = new Map(rows.map((r) => [r.account_code, r.id]));
  return named.flatMap(([subtype, toCode]) => {
    const fromId = (roles.holders as Map<string, string>).get(subtype) ?? null;
    const unchanged = fromId !== null && idOfCode.get(toCode) === fromId && !(roles.contested as Set<string>).has(subtype);
    return unchanged ? [] : [{ subtype, fromId, toCode }];
  });
}

/** Refuses (CoaRoleChangeForbiddenError) when the actor may not move the bank role and `moves` moves it. */
export function assertActorMayMoveRoles(actor: CoaImportActor | undefined, moves: readonly RoleMove[]): void {
  if (!actor || canSetPayrollNetPay(actor.role) || !moves.some((m) => m.subtype === 'bank')) return;
  throw new CoaRoleChangeForbiddenError(
    `Your role (${actor.role ?? 'unknown'}) cannot move the bank role: with Payroll net pay unset, payroll credits net pay to the bank account, `
    + 'so only an owner or admin can change it. Remove "bank" from the system account map, or ask an owner or admin to run the import.',
  );
}

/** One audit row for the roles the import moved (same entity and shape as a Default Accounts save). Call after the writes. */
export async function auditRoleMoves(companyId: string, actor: CoaImportActor | undefined, moves: readonly RoleMove[]): Promise<void> {
  if (!actor || moves.length === 0) return;
  const rows = (await sql`
    SELECT account_code, id::TEXT AS id FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ANY(${moves.map((m) => m.toCode)}::TEXT[])
  `) as Array<{ account_code: string; id: string }>;
  const idOfCode = new Map(rows.map((r) => [r.account_code, r.id]));
  const changes: DefaultAccountChange[] = moves.map((m) => ({ key: uiKeyOf(m.subtype), fromId: m.fromId, toId: idOfCode.get(m.toCode) ?? null }));
  await auditDefaultAccountChanges(sql, companyId, actor.userId, changes);
}
