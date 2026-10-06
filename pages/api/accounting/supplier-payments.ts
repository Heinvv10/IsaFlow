/**
 * Supplier Payments API
 * GET  /api/accounting/supplier-payments - List payments
 * POST /api/accounting/supplier-payments - Create payment with allocations
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { UUID, ISODate } from '@/lib/schemas/common';
import {
  getSupplierPayments,
  getSupplierPaymentById,
  createSupplierPayment,
} from '@/modules/accounting/services/ap/supplierPaymentService';
import type { PaymentStatus } from '@/modules/accounting/types/ap.types';
import { describeApprovalGate } from '@/modules/accounting/services/gl/approvalGate';
import { sql } from '@/lib/neon';
import { SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import {
  isRetryableSupplierPaymentRefusal,
  isSupplierPaymentRefusal,
} from '@/modules/accounting/services/ap/supplierPaymentRefusal';

const CreateSupplierPaymentSchema = z.object({
  supplierId: UUID,
  paymentDate: ISODate,
  totalAmount: z.coerce.number().nonnegative().multipleOf(0.01),
  paymentMethod: z.enum(['eft', 'cheque', 'cash', 'card']).optional(),
  bankAccountId: UUID.optional(),
  reference: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  allocations: z.array(z.object({
    invoiceId: UUID,
    amount: z.coerce.number().nonnegative().multipleOf(0.01),
  })).min(1).max(200),
});

async function getHandler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  try {
    const { id, status, supplier_id, limit, offset } = req.query;

    // Single payment by ID
    if (id) {
      const payment = await getSupplierPaymentById(companyId, id as string);
      if (!payment) return apiResponse.notFound(res, 'Payment', id as string);
      // R-035 PR5: the derived approval state while approve or process is still
      // ahead. A batch member has none of its own — its batch's page shows it.
      const approval = !payment.batchId && (payment.status === 'draft' || payment.status === 'approved')
        ? await describeApprovalGate(companyId, 'supplier_payment', payment.id) : null;
      // Where the money goes, read live like the approval digest (round 1 LOW c).
      const [bank] = (await sql`
        SELECT bank_name, bank_account_number, bank_branch_code, bank_account_holder FROM suppliers
        WHERE id = ${payment.supplierId}::UUID AND company_id = ${companyId}::UUID
      `) as Record<string, string | null>[];
      const payeeBank = bank ? {
        bankName: bank.bank_name, accountNumber: bank.bank_account_number,
        branchCode: bank.bank_branch_code, accountHolder: bank.bank_account_holder,
      } : null;
      return apiResponse.success(res, { ...payment, approval, payeeBank });
    }

    const result = await getSupplierPayments(companyId, {
      status: status as PaymentStatus | undefined,
      supplierId: supplier_id ? String(supplier_id) : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to get supplier payments', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to get supplier payments');
  }
}

async function postHandler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const postParsed = CreateSupplierPaymentSchema.safeParse(req.body);
  if (!postParsed.success) {
    return apiResponse.validationError(res, postParsed.error.flatten().fieldErrors as Record<string, string[]>);
  }
  try {
    const { supplierId, paymentDate, totalAmount, paymentMethod,
      bankAccountId, reference, description, allocations } = postParsed.data;

    // User identity comes from JWT (req.user), never from client request body
    const userId = req.user.id;

    const payment = await createSupplierPayment(companyId, {
      supplierId, paymentDate, totalAmount,
      paymentMethod, bankAccountId, reference, description,
      allocations,
    }, userId);

    return apiResponse.created(res, payment);
  } catch (err) {
    // R-068: raised before the first write, so the 400's COMMIT commits nothing.
    if (err instanceof SupplierNotInCompanyError) return apiResponse.badRequest(res, err.message);
    // A bill held by another request: a retry, not the user's mistake — 503 + Retry-After (D11), as batch-payments
    // POST answers the same lock; a retryable state conflict stays 409. Pre-write, like every refusal.
    if (respondIfLockTimeout(res, err)) return;
    if (isRetryableSupplierPaymentRefusal(err)) return apiResponse.conflict(res, (err as Error).message);
    // K-066: a bill that is not this supplier's, or not payable. Also pre-write.
    if (isSupplierPaymentRefusal(err)) return apiResponse.badRequest(res, err.message);
    log.error('Failed to create supplier payment', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to create payment');
  }
}

const meteredPost = withFlowMeter('payment.record', getFlowCost('payment.record'))(postHandler);

async function mux(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return getHandler(req, res);
  if (req.method === 'POST') return meteredPost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(mux))));
