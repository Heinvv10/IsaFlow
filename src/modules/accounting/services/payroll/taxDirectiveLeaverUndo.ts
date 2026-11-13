/**
 * Undoing a leaver exit (Hein's ruling on #1266 L2, the narrow undo). A leaver exit set a regular-pay directive's expiry
 * before a run it taxed, at the leave date of an employee who left before that period (taxDirectiveRegularPayChange), and
 * wrote an audit row (`leaverExit`). While EVERY run that exit named is reopened (not approved or paid), a payroll approver
 * may restore the directive's expiry to EXACTLY what it was before the exit, and to nothing else:
 *   - the restore is the one way to lengthen an expiry; any other later date stays refused (shorten-only, 400);
 *   - no exit in effect (none recorded, or the expiry is not the exit's any more): 400;
 *   - another date: 400; a named run not reopened: 409;
 *   - any other run that taxed the employee (ever approved) inside the window the restore re-covers, from the day after the
 *     exit's expiry to the restored end: 409 (LeaverExitWindowTakenError); a second directive overlapping it is refused by
 *     the approved-directive overlap check in taxDirectiveRegularPayChange;
 *   - four eyes: the person who took the exit may not restore it while another owner / admin / manager in good standing
 *     exists, or while one who could approve at the exit (`approversAtExit` on its audit row) is still active whatever their
 *     role now, or was removed since (403, TaxDirectiveSelfApprovalError); a one-person company may, and the audit row says so.
 * The restore writes its own audit row (`leaverExitUndo`, old and new expiry, the exit's audit id). With the directive in
 * force again the exit no longer holds the end date (payrollRunDirectiveUses), so the end date can be corrected and the
 * run recalculated with the employee back in it. Everything is judged before the write; company-scoped.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { anotherApproverBlocks, TaxDirectiveSelfApprovalError } from './taxDirectiveApprover';
import { TaxDirectiveWindowError } from './taxDirectiveOverlap';
import { declarableRunInWindow } from './payrollRunRegularDirective';
import { regularDirectiveUsesAfter } from './payrollRunDirectiveUses';
import { DEFAULT_WRITE_ROLES } from '@/lib/auth/writeRoles';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';

export class LeaverExitRunNotReopenedError extends Error {
  readonly code = 'LEAVER_EXIT_RUN_NOT_REOPENED';
  constructor(message: string) {
    super(message);
    this.name = 'LeaverExitRunNotReopenedError';
  }
}

export class LeaverExitWindowTakenError extends Error {
  readonly code = 'LEAVER_EXIT_WINDOW_TAKEN';
  constructor(message: string) {
    super(message);
    this.name = 'LeaverExitWindowTakenError';
  }
}

export interface LeaverExitUndo { exitAuditId: string; oldExpiry: string | null; oldEndsOn: string; periods: string[]; selfApproval: boolean }

/** Whether `userId` is an owner / admin / manager in good standing of the company (the actor's own row, or another's via the R-035 definer). */
async function isPayrollApprover(companyId: string, userId: string, actorId: string): Promise<boolean> {
  type Member = { user_id: string; role: string; is_active: boolean | null; status: string | null; suspended_at: string | null };
  const members = (userId.toLowerCase() === actorId.toLowerCase()
    ? await sql`
        SELECT cu.user_id, cu.role, TRUE AS is_active, NULL::text AS status, NULL::timestamptz AS suspended_at
        FROM company_users cu WHERE cu.company_id = ${companyId}::uuid AND lower(cu.user_id) = ${userId.toLowerCase()}
      `
    : await sql`
        SELECT m.user_id, m.role, m.is_active, m.status, m.suspended_at FROM approval_company_other_members(${companyId}::uuid, ${actorId}::text) m
      `) as Member[];
  const writers: readonly string[] = DEFAULT_WRITE_ROLES;
  return members.some(m => String(m.user_id).toLowerCase() === userId.toLowerCase() && writers.includes(String(m.role)) && isActiveUserAccount(m));
}

/**
 * The exit in effect on this directive (its latest leaver-exit row, if the expiry is still that exit's and not undone), else null.
 * TRUST BOUNDARY (#1266 rev2 L1): the exit is read from audit_log, which only the leaver-exit path
 * (taxDirectiveRegularPayChange.auditLeaverExit) writes with `leaverExit` metadata; no route lets a caller choose audit
 * metadata. app_user can still INSERT audit_log rows under tenant RLS, so a row is accepted only when it is this company's
 * and this directive's, its newExpiry is the directive's expiry now, its runs are exactly the directive's recorded uses after
 * that expiry (payroll_run_directive_uses), and its actor is a payroll approver (owner / admin / manager in good standing)
 * today. Named limit: an exit whose taker has since lost that role is not undoable (another approver takes no new exit).
 */
async function exitInEffect(companyId: string, directiveId: string, currentExpiry: string | null, actorId: string) {
  const r = ((await sql`
    SELECT a.id::text AS id, a.user_id, a.changes
    FROM audit_log a
    WHERE a.company_id = ${companyId}::uuid AND a.entity_type = 'tax_directive' AND a.entity_id = ${directiveId}::uuid
      AND a.action = 'update' AND a.changes->'metadata'->>'leaverExit' = 'true'
      AND NOT EXISTS (
        SELECT 1 FROM audit_log u
        WHERE u.company_id = a.company_id AND u.entity_type = 'tax_directive' AND u.entity_id = a.entity_id
          AND u.changes->'metadata'->>'exitAuditId' = a.id::text
      )
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1
  `) as DbRow[])[0];
  if (!r) return null;
  const meta = ((r.changes as { metadata?: Record<string, string> } | null)?.metadata ?? {});
  const field = ((r.changes as { fields?: Array<{ field: string; old: string | null }> } | null)?.fields ?? []).find(f => f.field === 'expiry_date');
  if (meta.newExpiry !== currentExpiry || currentExpiry == null) return null;
  const periods = String(meta.runs ?? '').split(',').filter(Boolean);
  const uses = (await regularDirectiveUsesAfter(companyId, directiveId, currentExpiry)).map(u => u.period);
  if (uses.length === 0 || uses.join(',') !== [...periods].sort().join(',')) return null;
  if (!await isPayrollApprover(companyId, String(r.user_id), actorId)) return null;
  return {
    id: String(r.id), takenBy: String(r.user_id), oldExpiry: field?.old ?? null, oldEndsOn: String(meta.oldEndsOn),
    approversAtExit: String(meta.approversAtExit ?? '').split(',').filter(Boolean),
    periods,
  };
}

/** Judge a request to lengthen the expiry to `requested` (see the header); returns the undo to write, or throws. */
export async function judgeLeaverExitUndo(
  companyId: string, directive: { id: string; employeeId: string; expiryDate: string | null }, requested: string, actorId: string,
): Promise<LeaverExitUndo> {
  const exit = await exitInEffect(companyId, directive.id, directive.expiryDate, actorId);
  if (!exit) {
    throw new TaxDirectiveWindowError('An expiry date can only shorten the directive (SARS issues a new directive for a longer period). '
      + 'It can be lengthened only to undo a leaver exit, and none is in effect on this directive.');
  }
  if (requested !== exit.oldEndsOn) {
    throw new TaxDirectiveWindowError(`Undoing the leaver exit restores the expiry to exactly ${exit.oldEndsOn}, what it was before the exit; not ${requested}.`);
  }
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const closed = (await sql`
    SELECT h.period_year, h.period_month FROM payroll_run_headers h
    WHERE h.company_id = ${companyId}::uuid AND h.status = ANY(${declarable}::text[])
      AND to_char(make_date(h.period_year, h.period_month, 1), 'YYYY-MM') = ANY(${exit.periods}::text[])
    ORDER BY 1, 2
  `) as DbRow[];
  if (closed.length > 0) {
    const named = closed.map(r => `${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`).join(', ');
    throw new LeaverExitRunNotReopenedError(`Reopen the ${named} payroll run first: the leaver exit can be undone only while every run it changed is reopened.`);
  }
  // The window the restore re-covers: nothing in it may already be taxed other than the reopened runs the exit named.
  const from = (await sql`SELECT (${directive.expiryDate}::date + 1)::text AS d`) as DbRow[];
  const taken = await declarableRunInWindow(companyId, directive.employeeId, String(from[0]!.d), exit.oldEndsOn, exit.periods);
  if (taken) {
    throw new LeaverExitWindowTakenError(`The ${taken} payroll run taxed this employee inside the window the restore would cover again `
      + `(${String(from[0]!.d)} to ${exit.oldEndsOn}): the leaver exit cannot be undone while it stands.`);
  }
  const self = exit.takenBy.toLowerCase() === actorId.toLowerCase();
  // Four eyes against the roster at the exit as well as today's (#1266 adv2 L: demoting the other approver first does not help).
  if (self && await anotherApproverBlocks(companyId, actorId, exit.approversAtExit)) throw new TaxDirectiveSelfApprovalError();
  return { exitAuditId: exit.id, oldExpiry: exit.oldExpiry, oldEndsOn: exit.oldEndsOn, periods: exit.periods, selfApproval: self };
}

/** The restore's audit row, on the request's transaction after the update. */
export async function auditLeaverExitUndo(
  companyId: string, directive: { id: string; number: string | null; employeeId: string; expiryDate: string | null }, undo: LeaverExitUndo, userId: string,
): Promise<void> {
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'tax_directive', entityId: directive.id, entityRef: directive.number ?? undefined,
    changes: {
      fields: [{ field: 'expiry_date', old: directive.expiryDate, new: undo.oldExpiry, label: 'Expiry date' }],
      metadata: {
        leaverExitUndo: 'true', exitAuditId: undo.exitAuditId, employeeId: directive.employeeId, runs: undo.periods.join(','),
        restoredEndsOn: undo.oldEndsOn, ...(undo.selfApproval ? { selfApproval: 'sole_approver' } : {}),
      },
    },
  });
}
