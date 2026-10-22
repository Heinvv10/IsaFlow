/**
 * POST /api/accounting/netcash/submit
 * Submit an EFT batch to Netcash.
 * Body: { batchPaymentId: string } - an approved supplier payment batch. A raw payments[] list is refused (400).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { validateNetcashPayees } from '@/modules/accounting/services/ap/netcashPayeeValidation';
import { liveNetcashSubmission } from '@/modules/accounting/services/ap/netcashBatchGuard';
import { unreleasedBankFile } from '@/modules/accounting/services/ap/batchBankFileRecord';
import { AnswerNotRecordedError, claimBatch, type SettleResult } from '@/modules/accounting/services/ap/netcashSubmissionClaim';
import {
  respondAnswerNotRecorded, respondClaimLost, respondSendBusy, respondSendFenced,
} from '@/modules/accounting/services/ap/netcashSubmitResponses';
import { replaySpooledAnswers } from '@/modules/accounting/services/ap/netcashAnswerSpoolReplay';
import { probeSpoolWritable } from '@/modules/accounting/services/ap/netcashAnswerSpool';
import { submitEftBatch, type NetcashPayment, type NetcashSubmitResult } from '@/modules/accounting/services/ap/netcashService';
import { assertBatchMayBeSent, BatchNotSendableError } from '@/modules/accounting/services/ap/batchBankFileGate';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import { assertSuppliersBankVerified, respondIfBankDetailsUnverified } from '@/modules/accounting/services/ap/supplierBankVerificationGate';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req;

  await assertNotImpersonating(); // R-032 L5: first, before any read or write; nothing is claimed for a Login-as session
  void probeSpoolWritable(); // once per process: log.error if the spool directory is not writable, before an outage needs it
  void replaySpooledAnswers(); // residual 3a: answers spooled while the database was unwell move into audit_log; bounded, never throws

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

  const serviceKey = String(company.netcash_service_key ?? '').trim();
  const payoutsKey = String(company.netcash_payouts_key ?? '').trim();

  // K-132: refused before the batch is read or claimed. A mock success here would record a payment run that never left
  // and (AP-01) claim the batch for good.
  if (!serviceKey || !payoutsKey) {
    return apiResponse.badRequest(res, 'Netcash credentials are not configured for this company. Add the service key and payouts key in Company Settings.');
  }

  const { batchPaymentId } = req.body as { batchPaymentId?: unknown };

  // A raw payments[] list names no batch, so nothing can approve it, claim it or make it idempotent, and it has no
  // production caller (AP-01). Refused outright; the payments of an approved batch are the only way to send.
  if (typeof batchPaymentId !== 'string' || batchPaymentId === '') {
    return apiResponse.badRequest(res, 'Provide batchPaymentId: a raw payment list cannot be approved or claimed — submit an approved batch.');
  }
  if (!UUID.test(batchPaymentId)) return apiResponse.badRequest(res, 'batchPaymentId must be a batch id');

  // Load from existing batch — validate company ownership. FOR SHARE, FIRST (the batch row, then the gate's payee
  // lock: the order processBatch uses): a cancelBatch committing between this read and the send would otherwise
  // let a cancelled batch be sent. The cancel's UPDATE waits for this transaction. The claim and settle below run
  // on their own connections and take only FOR KEY SHARE (the batch_id foreign key), which FOR SHARE and a
  // waiting cancel (FOR NO KEY UPDATE) do not conflict with, so they never wait on this lock.
  const batch = await sql`
    SELECT id, batch_number, status FROM supplier_payment_batches
    WHERE id = ${batchPaymentId} AND company_id = ${companyId}::UUID
    LIMIT 1
    FOR SHARE
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
  const batchReference = String(batch[0].batch_number ?? batchPaymentId);

  // AP-01: a batch with a bank file is paid by that file, not also by Netcash - unless the file was released as not
  // used (eft-file-release). Read under the batch FOR SHARE above, which eft-generate's FOR NO KEY UPDATE conflicts
  // with: a file in progress is waited for, and every committed export is seen.
  const bankFile = await unreleasedBankFile(companyId, batchPaymentId);
  if (bankFile) {
    return apiResponse.conflict(res,
      `A bank file was generated for this batch (${bankFile.bank ?? 'bank'} file by ${bankFile.generatedBy} at ${bankFile.generatedAt}), `
      + 'so sending it to Netcash too would pay it twice. If the file was not used, an owner or admin can release it first.',
      { reason: 'BATCH_BANK_FILE_GENERATED', generatedBy: bankFile.generatedBy, generatedAt: bankFile.generatedAt });
  }

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
    WHERE sp.batch_id = ${batchPaymentId} AND sp.company_id = ${companyId}::UUID AND sp.status IS DISTINCT FROM 'cancelled'
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

  const payments: NetcashPayment[] = rows.map(r => ({
    accountHolder: String(r.account_holder ?? ''),
    // Digits only — the account and branch the fingerprint verified.
    bankCode: String(r.bank_code ?? '').replace(/\D/g, ''),
    accountNumber: String(r.account_number ?? '').replace(/\D/g, ''),
    amount: Math.round(Number(r.amount ?? 0) * 100),   // rands → cents
    reference: String(r.reference ?? ''),
  }));

  // Refused before anything is claimed or sent: a malformed or over-long account would otherwise reach Netcash as-is.
  const payeeErrors = validateNetcashPayees(payments);
  if (payeeErrors.length > 0) return apiResponse.badRequest(res, payeeErrors.join('; '), { errors: payeeErrors });

  const totalAmountCents = payments.reduce((s, p) => s + p.amount, 0);
  const createdBy = req.user?.email ?? 'system';

  // AP-01: a batch is sent once. A claim row (status 'pending', batch_id) is committed in its OWN transaction BEFORE the
  // send (ap/netcashSubmissionClaim); the partial UNIQUE index (migration 898) admits one non-failed row per batch, so
  // a second or concurrent request finds the batch claimed and is refused 409 without calling Netcash. The claim must
  // not ride in this request's transaction: withAuth rolls that back on any >=500, a crash or a timeout, and the claim
  // of a batch that may already be paid would go with it.
  const principal = { companyId, userId: req.user.id, claims: (req.user?.claims ?? {}) as Record<string, unknown> };
  const claimed = await claimBatch(principal, {
    batchId: batchPaymentId, batchReference, totalAmountCents,
    recordCount: payments.length, createdBy,
  });
  if (claimed.kind === 'held') return respondBatchAlreadyClaimed(res, companyId, batchPaymentId);
  if (claimed.kind === 'busy') return respondSendBusy(res, claimed.reason);
  const { claim } = claimed;
  const claimId = claim.id;

  // The claim's connection holds its send lock (ap/netcashSendLock) from before the claim committed until the settle
  // has: netcash/resolve refuses the claim while this request is alive, however long the send stalls. end() always.
  let result: NetcashSubmitResult;
  let status: 'submitted' | 'failed' | 'unknown';
  let settled: SettleResult;
  try {
    try {
      // The claim's fence (residual 3b): a send that waited too long since before the claim is refused at the last
      // synchronous step before the request - a paused process must not send after an operator could have freed its claim.
      result = await submitEftBatch(serviceKey, payoutsKey, payments, claim.fence);
    } catch (err) {
      // The service answers every failure itself; a throw here is unexpected, and the request may have left.
      log.error('Netcash EFT submit threw', { error: err instanceof Error ? err.message : String(err) }, 'netcash-api');
      result = { success: false, outcome: 'unknown', error: 'Unexpected error while submitting to Netcash' };
    }

    // 'failed' only when Netcash definitely refused the batch (it may then be sent again); an indeterminate outcome is
    // 'unknown' and keeps the batch claimed until someone has checked Netcash.
    status = result.success ? 'submitted' : result.outcome === 'rejected' ? 'failed' : 'unknown';
    const reference = result.batchReference ?? batchReference;
    const submittedAt = result.success ? new Date().toISOString() : null;

    // Settled in its own committed transaction (retried once on a fresh connection, ap/netcashClaimSettle). If both
    // fail the claim stays 'pending' - the batch stays closed until an operator clears it - and the request answers
    // 500 saying what Netcash answered, so no one resends a batch Netcash may have.
    try {
      settled = await claim.settle({ status, batchReference: reference, netcashResponse: result, submittedAt });
    } catch (err) {
      log.error('Netcash claim not settled; left pending (the batch stays closed until an operator clears it)', {
        submissionId: claimId, outcome: result.outcome, error: err instanceof Error ? err.message : String(err),
      }, 'netcash-api');
      if (err instanceof AnswerNotRecordedError) return respondAnswerNotRecorded(res, claimId, result);
      throw err;
    }
  } finally {
    await claim.end();
  }
  // Fenced: nothing was sent, whatever became of the row meanwhile (settled failed, or an operator freed it first).
  if (result.fenced) return respondSendFenced(res, claimId, claim.fence.elapsedMs(), settled.kind === 'lost' ? settled.status : 'failed');
  if (settled.kind === 'lost') return respondClaimLost(res, claimId, result, settled);
  const submissionId = claimId;

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
  const held = await liveNetcashSubmission(companyId, batchId);
  if (!held) return apiResponse.conflict(res, 'This batch is being submitted to Netcash. Try again shortly.');
  const message = held.status === 'unknown' || held.status === 'pending'
    ? `An earlier submission of this batch (${held.id}) is ${held.status === 'pending' ? 'in flight, or its outcome was not recorded' : 'of unknown outcome'}: Netcash may have accepted it. Check Netcash before resubmitting.`
    : `This batch was already submitted to Netcash (submission ${held.id}, status ${held.status}).`;
  return apiResponse.conflict(res, message, { reason: 'BATCH_ALREADY_SUBMITTED', submissionId: held.id, status: held.status });
}

// withWriteAccess (R-035 PR5 round 1 LOW f): transmitting payments is a write — a read-only member may not send them.
// Owner/admin only (AP-01 review): a manager may not send, and may not generate a bank file that only owner/admin can release.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withAuth>[0], { allowedRoles: ['owner', 'admin'] }))));
