/**
 * Admin Sage Commit API
 *
 * POST /api/admin/migration/sage-commit
 * Body: {
 *   companyId: string,
 *   pulled: {
 *     customers?:  { records: MappedCustomer[] },
 *     suppliers?:  { records: MappedSupplier[] },
 *     arInvoices?: { records: MappedARInvoice[] },
 *     apInvoices?: { records: MappedAPInvoice[] },
 *   },
 * }
 *
 * Persists mapped Sage data into the target company and posts journal
 * entries. Idempotent on invoice_number (skipped if already present).
 * Per-record errors don't abort the batch — the response includes a
 * counts summary plus a list of failures.
 *
 * Staff-only via withAdmin.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { commitSageMigration } from '@/modules/admin/services/sageMigrationCommitService';
import type {
  MappedAccount,
  MappedCustomer,
  MappedSupplier,
  MappedARInvoice,
  MappedAPInvoice,
  BankTx,
} from '@/modules/admin/services/sageMigrationCommitService';

interface CommitBody {
  companyId?: string;
  pulled?: {
    accounts?:         { records?: MappedAccount[] };
    customers?:        { records?: MappedCustomer[] };
    suppliers?:        { records?: MappedSupplier[] };
    arInvoices?:       { records?: MappedARInvoice[] };
    apInvoices?:       { records?: MappedAPInvoice[] };
    bankTransactions?: { bankAccountId: string; records: BankTx[] };
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const body = (req.body ?? {}) as CommitBody;
  const { companyId, pulled } = body;

  if (!companyId) return apiResponse.validationError(res, { companyId: 'companyId is required' });
  if (!pulled)    return apiResponse.validationError(res, { pulled: 'pulled data is required' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (req as any).user?.id ?? 'sage-migration';

  const summary = await commitSageMigration({ companyId, userId, pulled });
  return apiResponse.success(res, summary);
}

import { withCsrf } from '@/lib/auth/withCsrf';
export default withAdmin(withCsrf(handler));
