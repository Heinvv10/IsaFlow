/** POST /api/accounting/expense-claims/[id]/post */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { postClaimToGl, ClaimNotPostableError } from '@/modules/accounting/services/expense/expenseClaimService';
import { sql } from '@/lib/neon';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PostBody {
  reimbursementAccountId?: string;
  vatInputAccountId?: string | null;
}

interface AccountRow {
  id: string;
  account_code: string;
  account_type: string;
  is_leaf: boolean;
}

async function validateLeafAccount(
  accountId: string,
  companyId: string,
  expectedType: AccountRow['account_type'] | AccountRow['account_type'][],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rows = (await sql`
    SELECT
      ga.id,
      ga.account_code,
      ga.account_type,
      NOT EXISTS (
        SELECT 1 FROM gl_accounts ch
         WHERE ch.parent_account_id = ga.id
           AND ch.company_id = ga.company_id
      ) AS is_leaf
    FROM gl_accounts ga
    WHERE ga.id = ${accountId}::uuid
      AND ga.company_id = ${companyId}::uuid
    LIMIT 1
  `) as AccountRow[];

  const acct = rows[0];
  if (!acct) return { ok: false, reason: 'Account not found' };
  if (!acct.is_leaf) {
    return {
      ok: false,
      reason: `Account ${acct.account_code} is a parent header (has child accounts) — pick a leaf account`,
    };
  }
  const allowed = Array.isArray(expectedType) ? expectedType : [expectedType];
  if (!allowed.includes(acct.account_type)) {
    return {
      ok: false,
      reason: `Account ${acct.account_code} type=${acct.account_type}; expected ${allowed.join(' or ')}`,
    };
  }
  return { ok: true };
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  const userId = req.user?.id ?? '';
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Expense claim', id);
  if (!userId) return apiResponse.unauthorized(res);

  const body = (req.body ?? {}) as PostBody;
  if (!body.reimbursementAccountId) {
    return apiResponse.badRequest(res, 'reimbursementAccountId is required');
  }
  if (!UUID_RE.test(body.reimbursementAccountId)) {
    return apiResponse.badRequest(res, 'reimbursementAccountId must be a UUID');
  }
  if (body.vatInputAccountId && !UUID_RE.test(body.vatInputAccountId)) {
    return apiResponse.badRequest(res, 'vatInputAccountId must be a UUID');
  }

  // Defensive: the reimbursement account MUST be a leaf liability. Posting to a
  // parent header (e.g. account 2000 "Liabilities") leaves the credit invisible
  // to the BS calculation (level<3 filter). See migration 484 for the prior incident.
  const reimbCheck = await validateLeafAccount(body.reimbursementAccountId, companyId, 'liability');
  if (!reimbCheck.ok) {
    return apiResponse.badRequest(res, `reimbursementAccountId invalid: ${reimbCheck.reason}`);
  }
  if (body.vatInputAccountId) {
    const vatCheck = await validateLeafAccount(body.vatInputAccountId, companyId, 'asset');
    if (!vatCheck.ok) {
      return apiResponse.badRequest(res, `vatInputAccountId invalid: ${vatCheck.reason}`);
    }
  }

  try {
    const claim = await postClaimToGl(id, companyId, {
      userId,
      reimbursementAccountId: body.reimbursementAccountId,
      vatInputAccountId: body.vatInputAccountId ?? null,
    });
    if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
    return apiResponse.success(res, { claim });
  } catch (err) {
    // Only the pre-write validation failures may become a 400. withAuth
    // finalises on `statusCode >= 500`, so a 4xx COMMITs — 400-ing a failure
    // that happened AFTER createJournalEntry would leave the draft journal
    // behind. Everything else propagates to a 500 and rolls back.
    if (err instanceof ClaimNotPostableError) {
      return apiResponse.badRequestFromError(res, err, 'Request failed');
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
