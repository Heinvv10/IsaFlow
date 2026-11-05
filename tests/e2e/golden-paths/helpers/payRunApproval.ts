/**
 * Clears a pay run for approval (R-035: every pay run needs an approval request decided by someone other than the
 * requester, except where the requester is the company's sole eligible approver).
 *
 * CI slots have one member, so the audited sole-approver exception lets the suite user approve their own request. The
 * production Demo company has several owners and an admin, so there a second user must decide it: E2E_APPROVER_EMAIL
 * and E2E_APPROVER_PASSWORD (post-deploy verify reads them from /home/hein/isaflow-deploy.env). The approver gets a
 * login of their own, in the requester's active company, and never touches the suite's stored session.
 */
import { Api, ApiError } from '../_api';

export interface ApproverCreds {
  email: string;
  password: string;
}

/** @returns the approver, or null when neither variable is set. @throws when only one is. */
export function readApprover(env: Record<string, string | undefined>): ApproverCreds | null {
  const email = env.E2E_APPROVER_EMAIL ?? '';
  const password = env.E2E_APPROVER_PASSWORD ?? '';
  if (!email && !password) return null;
  if (!email || !password) {
    throw new Error(
      `E2E_APPROVER_EMAIL and E2E_APPROVER_PASSWORD must be set together; missing: ${email ? 'E2E_APPROVER_PASSWORD' : 'E2E_APPROVER_EMAIL'}`,
    );
  }
  return { email, password };
}

const HINT =
  'If this company has more than one eligible approver, set E2E_APPROVER_EMAIL and E2E_APPROVER_PASSWORD '
  + '(an owner/admin of the same company, not the E2E_ADMIN user, without MFA) in /home/hein/isaflow-deploy.env, or export them. '
  + 'The refusal can also mean self-approval enforcement changed or the approver roster did.';

function isSelfApproval(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.body as { error?: { details?: { reason?: string } } })?.error?.details?.reason === 'SELF_APPROVAL_FORBIDDEN';
}

async function approve(api: Api, decision: object): Promise<void> {
  try {
    await api.post('/api/accounting/approval-requests', decision);
  } catch (err) {
    if (isSelfApproval(err)) throw new Error(`pay run approval refused as SELF_APPROVAL_FORBIDDEN. ${HINT} (${err.message})`);
    throw err;
  }
}

async function activeCompanyId(api: Api): Promise<string> {
  const uc = await api.get<{ activeCompanyId?: string }>('/api/accounting/companies?action=user-companies');
  const id = String(uc?.activeCompanyId ?? '');
  if (!id) throw new Error('pay run approval: the suite session has no active company');
  return id;
}

/**
 * Raises the pay-run approval request as `api` and gets it approved.
 * `selfApprove` ignores E2E_APPROVER_* (a spec working in a company the approver does not belong to, e.g. z6's sandbox).
 */
export async function clearPayRunApproval(
  api: Api, baseURL: string, runId: string, opts: { selfApprove?: boolean } = {},
): Promise<void> {
  const approver = opts.selfApprove ? null : readApprover(process.env); // before any write: a bad config fails first
  if (approver && approver.email.toLowerCase() === (process.env.E2E_ADMIN_EMAIL ?? '').toLowerCase()) {
    throw new Error('E2E_APPROVER_EMAIL is the E2E_ADMIN user: the approver must be a different person or the approval is a self-approval.');
  }
  const request = await api.post<{ id: string; documentDigest: string }>('/api/accounting/approval-requests', {
    action: 'request', documentType: 'pay_run', documentId: runId,
  });
  const decision = { action: 'approve', requestId: request.id, expectedDigest: request.documentDigest };
  if (!approver) return approve(api, decision);

  const second = await Api.loginAs(baseURL, { ...approver, companyId: await activeCompanyId(api) });
  try {
    await approve(second, decision);
  } finally {
    await second.dispose();
  }
}
