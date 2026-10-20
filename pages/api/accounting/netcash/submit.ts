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
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { submitEftBatch, type NetcashPayment, type NetcashSubmitResult } from '@/modules/accounting/services/ap/netcashService';
import { assertBatchMayBeSent, BatchNotSendableError } from '@/modules/accounting/services/ap/batchBankFileGate';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import { isEnforced } from '@/modules/accounting/services/gl/approvalEnforcement';
import {
  assertRawPaymentListAllowed, assertSuppliersBankVerified, respondIfBankDetailsUnverified,
} from '@/modules/accounting/services/ap/supplierBankVerificationGate';

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
    // bank_fingerprint: of the five bank columns as read here (account and branch sent as digits, as it normalises them).
    // The account holder sent is the supplier name, which it does not cover.
    const rows = await sql`
      SELECT sp.total_amount AS amount, sp.reference, sp.supplier_id,
             s.name as account_holder, s.bank_branch_code as bank_code,
             s.bank_account_number as account_number,
             supplier_bank_fingerprint(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type,
                                       s.bank_account_holder) AS bank_fingerprint
      FROM supplier_payments sp
      JOIN suppliers s ON sp.supplier_id = s.id
      WHERE sp.batch_id = ${batchPaymentId} AND sp.company_id = ${companyId}::UUID
      ORDER BY sp.created_at
    ` as Row[];

    if (rows.length === 0) return apiResponse.badRequest(res, 'No payments found in batch');
    // Supplier bank verification: every payee's details as read above must be
    // verified now, payees share-locked (ap/supplierBankVerificationGate). 409
    // naming the suppliers, before anything is sent or recorded. Off: unchanged.
    try {
      await assertSuppliersBankVerified(companyId, rows.map((r) => ({
        supplierId: String(r.supplier_id), fingerprint: String(r.bank_fingerprint),
      })));
    } catch (err) {
      if (respondIfBankDetailsUnverified(res, err)) return;
      throw err;
    }

    payments = rows.map(r => ({
      accountHolder: String(r.account_holder ?? ''),
      // Digits only — the account and branch the fingerprint verified.
      bankCode: String(r.bank_code ?? '').replace(/\D/g, ''),
      accountNumber: String(r.account_number ?? '').replace(/\D/g, ''),
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
    // …and under supplier bank verification, whether or not payments are approved (decision 8): 403.
    try {
      await assertRawPaymentListAllowed(companyId);
    } catch (err) {
      if (respondIfBankDetailsUnverified(res, err)) return;
      throw err;
    }
    payments = rawPayments;
  } else {
    return apiResponse.badRequest(res, 'Provide batchPaymentId or payments array');
  }

  const totalAmountCents = payments.reduce((s, p) => s + p.amount, 0);
  const createdBy = req.user?.email ?? 'system';

  // AP-01: a batch is sent once. A claim row (status 'pending', batch_id) is inserted BEFORE the send; the partial
  // UNIQUE index (migration 898) admits one non-failed row per batch, so a concurrent second request blocks on the
  // index until this transaction ends, then finds the batch claimed and is refused. The claim commits with the
  // request, which is why every answer below the send is 4xx on a failure: withAuth ROLLS BACK a >=500, and the
  // claim of a batch that may already be paid would go with it. Raw payment lists name no batch and are not claimed.
  // Login-as is refused here, before the claim: a refusal (403) after it would commit a claim nothing settles.
  await assertNotImpersonating();
  let claimId: string | null = null;
  if (batchPaymentId) {
    const claimed = await sql`
      INSERT INTO netcash_submissions (
        company_id, submission_type, batch_reference, total_amount_cents, record_count, status, created_by, batch_id
      ) VALUES (
        ${companyId}::UUID, 'eft_payment', ${batchReference ?? null}, ${totalAmountCents}, ${payments.length},
        'pending', ${createdBy}, ${batchPaymentId}::UUID
      )
      ON CONFLICT (company_id, batch_id) WHERE batch_id IS NOT NULL AND status <> 'failed' DO NOTHING
      RETURNING id
    ` as Row[];
    if (!claimed[0]) return respondBatchAlreadyClaimed(res, companyId, batchPaymentId);
    claimId = String(claimed[0].id);
  }

  let result: NetcashSubmitResult;
  try {
    result = await submitEftBatch(serviceKey, payoutsKey, payments);
  } catch (err) {
    // The service answers every failure itself; a throw here is unexpected, and the request may have left.
    log.error('Netcash EFT submit threw', { error: err instanceof Error ? err.message : String(err) }, 'netcash-api');
    result = { success: false, outcome: 'unknown', error: 'Unexpected error while submitting to Netcash' };
  }

  // 'failed' only when Netcash definitely refused the batch (it may then be sent again); an indeterminate outcome is
  // 'unknown' and keeps the batch claimed until someone has checked Netcash.
  const status = result.success ? 'submitted' : result.outcome === 'rejected' ? 'failed' : 'unknown';
  const reference = result.batchReference ?? batchReference ?? null;
  const submittedAt = result.success ? new Date().toISOString() : null;
  const response = JSON.stringify(result);

  let submissionId: string;
  if (claimId) {
    await sql`
      UPDATE netcash_submissions
      SET status = ${status}, batch_reference = ${reference}, netcash_response = ${response}::JSONB,
          submitted_at = ${submittedAt}
      WHERE id = ${claimId}::UUID AND company_id = ${companyId}::UUID
    `;
    submissionId = claimId;
  } else {
    const inserted = await sql`
      INSERT INTO netcash_submissions (
        company_id, submission_type, batch_reference,
        total_amount_cents, record_count, status,
        netcash_response, submitted_at, created_by
      ) VALUES (
        ${companyId}::UUID, 'eft_payment', ${reference}, ${totalAmountCents}, ${payments.length},
        ${status}, ${response}::JSONB, ${submittedAt}, ${createdBy}
      )
      RETURNING id
    ` as Row[];
    submissionId = String((inserted[0] as Row).id);
  }

  if (status === 'unknown') {
    log.error('Netcash EFT submit outcome unknown', { error: result.error, submissionId }, 'netcash-api');
    return apiResponse.conflict(res,
      'Netcash did not give a definite answer, so the batch may have been accepted. Check Netcash before resubmitting.',
      { reason: 'NETCASH_OUTCOME_UNKNOWN', submissionId });
  }
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

/** 409 naming the submission that holds the batch (the live row the claim ran into). */
async function respondBatchAlreadyClaimed(res: NextApiResponse, companyId: string, batchId: string): Promise<void> {
  const held = (await sql`
    SELECT id, status FROM netcash_submissions
    WHERE company_id = ${companyId}::UUID AND batch_id = ${batchId}::UUID AND status <> 'failed'
    ORDER BY created_at LIMIT 1
  ` as Row[])[0];
  if (!held) return apiResponse.conflict(res, 'This batch is being submitted to Netcash. Try again shortly.');
  const submissionId = String(held.id);
  const status = String(held.status);
  const message = status === 'unknown'
    ? `An earlier submission of this batch (${submissionId}) has an unknown outcome: Netcash may have accepted it. Check Netcash before resubmitting.`
    : `This batch was already submitted to Netcash (submission ${submissionId}, status ${status}).`;
  return apiResponse.conflict(res, message, { reason: 'BATCH_ALREADY_SUBMITTED', submissionId, status });
}

// withWriteAccess (R-035 PR5 round 1 LOW f): transmitting payments is a write — a read-only member may not send them.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withAuth>[0]))));
