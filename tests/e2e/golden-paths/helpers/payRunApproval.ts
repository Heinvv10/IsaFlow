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

const SELF_APPROVAL_HINT =
  'the pay run needs a second approver (SELF_APPROVAL_FORBIDDEN): this company has more than one eligible approver. '
  + 'Set E2E_APPROVER_EMAIL and E2E_APPROVER_PASSWORD (an owner/admin of the same company, not the E2E_ADMIN user) '
  + 'in /home/hein/isaflow-deploy.env, or export them.';

async function activeCompanyId(api: Api): Promise<string> {
  const uc = await api.get<{ activeCompanyId?: string }>('/api/accounting/companies?action=user-companies');
  const id = String(uc?.activeCompanyId ?? '');
  if (!id) throw new Error('pay run approval: the suite session has no active company');
  return id;
}

/** Raises the pay-run approval request as `api` and gets it approved. */
export async function clearPayRunApproval(api: Api, baseURL: string, runId: string): Promise<void> {
  const approver = readApprover(process.env); // before any write: a half-set pair fails loudly first
  const request = await api.post<{ id: string; documentDigest: string }>('/api/accounting/approval-requests', {
    action: 'request', documentType: 'pay_run', documentId: runId,
  });
  const decision = { action: 'approve', requestId: request.id, expectedDigest: request.documentDigest };

  if (!approver) {
    try {
      await api.post('/api/accounting/approval-requests', decision);
    } catch (err) {
      if (err instanceof ApiError && JSON.stringify(err.body).includes('SELF_APPROVAL_FORBIDDEN')) {
        throw new Error(`${SELF_APPROVAL_HINT} (${err.message})`);
      }
      throw err;
    }
    return;
  }

  const second = await Api.loginAs(baseURL, { ...approver, companyId: await activeCompanyId(api) });
  try {
    await second.post('/api/accounting/approval-requests', decision);
  } finally {
    await second.dispose();
  }
}
