/**
 * The ONLY writers of `approval_requests` (R-035 N1, migration 872).
 *
 * No role but the table's owner may INSERT, UPDATE, DELETE or lock a request:
 * every write goes through a SECURITY DEFINER function that repeats, in SQL,
 * what the TypeScript checks before it — the session user is the actor, the
 * company is the request's, the rule is the strictest governing the document,
 * a pending request moves only upwards, and a decision passes the rank,
 * author, requester (with the Q2 sole-approver exception), rule-visibility and
 * digest checks. The TypeScript keeps its own checks and messages; these
 * functions are the floor under them, so a mis-wired caller cannot write a
 * row the app would not.
 *
 * A refusal from SQL carries an RA0xx SQLSTATE and is mapped back onto the
 * error the TypeScript path throws for the same case, so a route answers the
 * same status. RA009 (forged: actor, company or rule binding) has no
 * TypeScript twin — the app never sends one — and surfaces as a 500.
 *
 * tests/unit/services/gl/approvalRequestWriteCensus.test.ts fails when any
 * other file writes the table or calls these functions.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { ApprovalDecisionError, ApprovalNotRequiredError } from './approvalAuthority';
import {
  ApprovalDocumentChangedError, ApprovalDocumentNotFoundError, ApprovalExpectedDigestRequiredError,
} from './approvalDocumentErrors';

type Row = Record<string, unknown>;

const sqlStateOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** RA003 / RA006 / RA007 from raise or rebind, as requestApproval throws them; anything else unchanged. */
export function raiseRefusal(error: unknown, documentType: string, documentId: string): unknown {
  switch (sqlStateOf(error)) {
    case 'RA003': return new ImpersonationForbiddenError();
    case 'RA006': return new ApprovalDocumentNotFoundError(documentType, documentId);
    case 'RA007': return new ApprovalNotRequiredError(documentType, documentId);
    default: return error;
  }
}

/** A decide refusal as decideRequest throws it; anything else unchanged. */
export function decideRefusal(error: unknown, requestId: string): unknown {
  switch (sqlStateOf(error)) {
    case 'RA001': return new ApprovalDecisionError('SELF_APPROVAL_FORBIDDEN', messageOf(error));
    case 'RA002': return new ApprovalDecisionError('APPROVER_ROLE_REQUIRED', messageOf(error));
    case 'RA003': return new ApprovalDecisionError('IMPERSONATION_FORBIDDEN', messageOf(error));
    case 'RA004': return new ApprovalDocumentChangedError(requestId);
    case 'RA005': return new ApprovalExpectedDigestRequiredError(requestId);
    case 'RA006': {
      const named = /^No (\S+) (\S+) exists for this company/.exec(messageOf(error));
      return new ApprovalDocumentNotFoundError(named?.[1] ?? 'document', named?.[2] ?? requestId);
    }
    default: return error;
  }
}

/**
 * approval_request_raise: a pending request for the document, bound to
 * `ruleId`. Empty when the rule went inactive. Not savepointed here: the
 * caller's savepoint is what turns the 23505 of a lost race into a re-read.
 */
export async function insertRequestRow(companyId: string, documentType: string, documentId: string,
  ruleId: string, requestedBy: string): Promise<Row[]> {
  return (await sql`
    SELECT * FROM approval_request_raise(${companyId}::UUID, ${documentType}::TEXT, ${documentId}::UUID,
                                         ${ruleId}::UUID, ${requestedBy}::TEXT)
  `) as Row[];
}

/** approval_request_rebind: `ruleId` null keeps the binding. Empty when nothing pending or the rule went inactive. */
export async function rebindRequestRow(companyId: string, requestId: string, ruleId: string | null,
  requestedBy: string, document: { type: string; id: string }): Promise<Row[]> {
  try {
    return await withSavepoint('approval_request_rebind', async () => (await sql`
      SELECT * FROM approval_request_rebind(${companyId}::UUID, ${requestId}::UUID, ${ruleId}::UUID, ${requestedBy}::TEXT)
    `) as Row[]);
  } catch (error) {
    throw raiseRefusal(error, document.type, document.id);
  }
}

/** approval_request_decide. Empty when the request is gone, foreign or already decided. */
export async function decideRequestRow(companyId: string, requestId: string, decision: 'approved' | 'rejected',
  decidedBy: string, notes: unknown, expectedDigest: string | null | undefined): Promise<Row[]> {
  try {
    return await withSavepoint('approval_request_decide', async () => (await sql`
      SELECT * FROM approval_request_decide(${companyId}::UUID, ${requestId}::UUID, ${decision}::TEXT,
                                            ${decidedBy}::TEXT, ${notes}::TEXT, ${expectedDigest ?? null}::TEXT)
    `) as Row[]);
  } catch (error) {
    throw decideRefusal(error, requestId);
  }
}

/** approval_request_lock: FOR UPDATE on the pending row, for the rest of the transaction. */
export async function lockRequestRow(companyId: string, requestId: string): Promise<void> {
  await sql`SELECT approval_request_lock(${companyId}::UUID, ${requestId}::UUID)`;
}
