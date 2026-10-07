/**
 * POST /api/accounting/netcash/submit
 * Submit an EFT batch to Netcash.
 * Body: { batchPaymentId?: string; payments?: NetcashPayment[] }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { submitEftBatch, type NetcashPayment } from '@/modules/accounting/services/ap/netcashService';
import { assertBatchMayBeSent, BatchNotSendableError } from '@/modules/accounting/services/ap/batchBankFileGate';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import { isEnforced } from '@/modules/accounting/services/gl/approvalEnforcement';

type Row = Record<string, unknown>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req;

  // Load company to get Netcash credentials
  const companies = await sql`
    SELECT netcash_service_key, netcash_payouts_key, netcash_enabled, name
    FROM companies
    WHERE id = ${companyId}::UUID
    LIMIT 1
  ` as Row[];

  const company = companies[0];
  if (!company) return apiResponse.notFound(res, 'Company', companyId);

  if (!company.netcash_enabled) {
    return apiResponse.badRequest(res, 'Netcash is not enabled for this company. Enable it in Company Settings.');
  }

  const serviceKey = String(company.netcash_service_key ?? '');
  const payoutsKey = String(company.netcash_payouts_key ?? '');

  let payments: NetcashPayment[];
  let batchReference: string | undefined;

  const { batchPaymentId, payments: rawPayments } = req.body as {
    batchPaymentId?: string;
    payments?: NetcashPayment[];
  };

  if (batchPaymentId) {
    // Load from existing batch — validate company ownership
    const batch = await sql`
      SELECT id, batch_number, status FROM supplier_payment_batches
      WHERE id = ${batchPaymentId} AND company_id = ${companyId}::UUID
      LIMIT 1
    ` as Row[];
    if (!batch[0]) return apiResponse.notFound(res, 'Batch', batchPaymentId);
    // R-035 PR5: under payment_batch enforcement only an approved batch the
    // approval gate clears is transmitted — its payees share-locked first
    // (ap/batchBankFileGate). 409 otherwise. Off: unchanged.
    try {
      await assertBatchMayBeSent(companyId, String(batch[0].id), String(batch[0].status));
    } catch (err) {
      if (respondIfApprovalRequired(res, err)) return;
      if (err instanceof BatchNotSendableError) return apiResponse.conflict(res, err.message);
      throw err;
    }
    batchReference = String(batch[0].batch_number ?? batchPaymentId);

    // total_amount: `amount` is no column, so this mode failed (500) for every batch (R-035 PR5 round 1 LOW e).
    const rows = await sql`
      SELECT sp.total_amount AS amount, sp.reference,
             s.name as account_holder, s.bank_branch_code as bank_code,
             s.bank_account_number as account_number
      FROM supplier_payments sp
      JOIN suppliers s ON sp.supplier_id = s.id
      WHERE sp.batch_id = ${batchPaymentId} AND sp.company_id = ${companyId}::UUID
      ORDER BY sp.created_at
    ` as Row[];

    if (rows.length === 0) return apiResponse.badRequest(res, 'No payments found in batch');

    payments = rows.map(r => ({
      accountHolder: String(r.account_holder ?? ''),
      bankCode: String(r.bank_code ?? ''),
      accountNumber: String(r.account_number ?? ''),
      amount: Math.round(Number(r.amount ?? 0) * 100),   // rands → cents
      reference: String(r.reference ?? ''),
    }));
  } else if (Array.isArray(rawPayments) && rawPayments.length > 0) {
    // R-035 PR5: a raw list names payees, accounts and amounts no document
    // carries, so nothing can approve it. Under either payment type's
    // enforcement it is refused before anything is sent.
    if (await isEnforced(companyId, 'supplier_payment') || await isEnforced(companyId, 'payment_batch')) {
      return apiResponse.error(res, ErrorCode.FORBIDDEN,
        'Supplier payment approvals are enforced, and a raw payment list cannot be approved — submit an approved batch.',
        { reason: 'APPROVAL_REQUIRED' });
    }
    payments = rawPayments;
  } else {
    return apiResponse.badRequest(res, 'Provide batchPaymentId or payments array');
  }

  const totalAmountCents = payments.reduce((s, p) => s + p.amount, 0);
  const result = await submitEftBatch(serviceKey, payoutsKey, payments);

  // Record submission regardless of outcome
  const inserted = await sql`
    INSERT INTO netcash_submissions (
      company_id, submission_type, batch_reference,
      total_amount_cents, record_count, status,
      netcash_response, submitted_at, created_by
    ) VALUES (
      ${companyId}::UUID, 'eft_payment',
      ${result.batchReference ?? batchReference ?? null},
      ${totalAmountCents}, ${payments.length},
      ${result.success ? 'submitted' : 'failed'},
      ${JSON.stringify(result)}::JSONB,
      ${result.success ? new Date().toISOString() : null},
      ${req.user?.email ?? 'system'}
    )
    RETURNING id
  ` as Row[];

  const submissionId = String((inserted[0] as Row).id);

  if (!result.success) {
    log.error('Netcash EFT submit failed', { error: result.error, submissionId }, 'netcash-api');
    return apiResponse.badRequest(res, result.error ?? 'Netcash submission failed');
  }

  log.info('Netcash EFT submitted', { submissionId, batchReference: result.batchReference, count: payments.length }, 'netcash-api');

  return apiResponse.success(res, {
    submissionId,
    batchReference: result.batchReference,
    recordCount: payments.length,
    totalAmountCents,
    mock: result.mock ?? false,
  });
}

// withWriteAccess (R-035 PR5 round 1 LOW f): transmitting payments is a write — a read-only member may not send them.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withAuth>[0]))));
