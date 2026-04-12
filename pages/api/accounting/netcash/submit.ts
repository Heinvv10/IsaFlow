/**
 * POST /api/accounting/netcash/submit
 * Submit an EFT batch to Netcash.
 * Body: { batchPaymentId?: string; payments?: NetcashPayment[] }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { submitEftBatch, type NetcashPayment } from '@/modules/accounting/services/netcashService';

type Row = Record<string, unknown>;

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
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
      SELECT id, batch_number FROM supplier_payment_batches
      WHERE id = ${batchPaymentId} AND company_id = ${companyId}::UUID
      LIMIT 1
    ` as Row[];
    if (!batch[0]) return apiResponse.notFound(res, 'Batch', batchPaymentId);
    batchReference = String(batch[0].batch_number ?? batchPaymentId);

    const rows = await sql`
      SELECT sp.amount, sp.reference,
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

export default withCompany(withErrorHandler(handler as Parameters<typeof withCompany>[0]));
