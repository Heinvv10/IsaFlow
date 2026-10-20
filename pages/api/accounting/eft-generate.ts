/**
 * EFT File Generation API
 * POST: generate EFT file for a batch payment
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  generateStandardBankACB, generateFNBEFT, generateABSAEFT,
  generateNedbankEFT, generateCapitecEFT, eftTruncationWarnings, validateEFTBatch,
  type EFTBatchHeader, type EFTPayment,
} from '@/modules/accounting/services/ap/eftService';
import { BANK_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';
import { assertBatchMayBeSent, BatchNotSendableError } from '@/modules/accounting/services/ap/batchBankFileGate';
import { respondIfApprovalRequired } from '@/modules/accounting/services/gl/approvalGateResponse';
import {
  assertSuppliersBankVerified, respondIfBankDetailsUnverified,
} from '@/modules/accounting/services/ap/supplierBankVerificationGate';

type Row = Record<string, unknown>;
type EFTAccountType = EFTPayment['beneficiaryAccountType'];

function toEFTAccountType(value: unknown): EFTAccountType {
  // Case-insensitive, as supplier_bank_fingerprint reads it: 'Savings' and 'savings' are one verified detail.
  const type = String(value ?? '').trim().toLowerCase();
  return type === 'savings' || type === 'transmission' || type === 'current' ? type : 'current';
}

const GENERATORS: Record<string, typeof generateStandardBankACB> = {
  standard_bank: generateStandardBankACB,
  fnb: generateFNBEFT,
  absa: generateABSAEFT,
  nedbank: generateNedbankEFT,
  capitec: generateCapitecEFT,
};

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { companyId } = req;
  const { batchId, bank } = req.body;
  if (!batchId) return apiResponse.badRequest(res, 'batchId is required');
  if (!bank || !GENERATORS[bank]) return apiResponse.badRequest(res, `Invalid bank. Supported: ${Object.keys(GENERATORS).join(', ')}`);

  // Get batch details — scoped to company
  // batch_date::text: pg hands a DATE back as a Date at local midnight, which toISOString() shifts a day in SAST.
  const batches = await sql`
    SELECT id, batch_number, status, bank_account_id, batch_date::text AS batch_date
    FROM supplier_payment_batches WHERE id = ${batchId} AND company_id = ${companyId}::UUID
  ` as Row[];
  if (!batches[0]) return apiResponse.notFound(res, 'Batch', batchId);
  // R-035 PR5: a bank file is money leaving, so under payment_batch
  // enforcement only an approved batch the approval gate clears gets one —
  // its payees share-locked first (ap/batchBankFileGate). 409 otherwise.
  // Enforcement off: unchanged.
  try {
    await assertBatchMayBeSent(companyId, String(batches[0].id), String(batches[0].status));
  } catch (err) {
    if (respondIfApprovalRequired(res, err)) return;
    if (err instanceof BatchNotSendableError) return apiResponse.conflict(res, err.message);
    throw err;
  }

  // Get payments in batch — scoped to company via batch ownership already validated above.
  // bank_fingerprint: of the five bank columns as read here, normalised as the file uses them (account and branch
  // digits, account type case-insensitive). The beneficiary NAME is the supplier name, which it does not cover.
  const payments = await sql`
    SELECT sp.*, s.name as supplier_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type, s.bank_name,
           supplier_bank_fingerprint(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type,
                                     s.bank_account_holder) AS bank_fingerprint
    FROM supplier_payments sp
    JOIN suppliers s ON sp.supplier_id = s.id
    WHERE sp.batch_id = ${batchId} AND sp.company_id = ${companyId}::UUID
      AND sp.status IS DISTINCT FROM 'cancelled'   -- a cancelled member (cancelBatch) is no payee
    ORDER BY sp.created_at
  ` as Row[];

  if (payments.length === 0) return apiResponse.badRequest(res, 'No payments in batch');

  // Supplier bank verification (forensic-controls step 1): under the control,
  // every payee's details as read above must be verified now — payees
  // share-locked to the end of the request (ap/supplierBankVerificationGate).
  // 409 naming the suppliers otherwise. Off: unchanged.
  try {
    await assertSuppliersBankVerified(companyId, payments.map((p) => ({
      supplierId: String(p.supplier_id), fingerprint: String(p.bank_fingerprint),
    })));
  } catch (err) {
    if (respondIfBankDetailsUnverified(res, err)) return;
    throw err;
  }

  // Build EFT header and payments. The originating account is the batch's paying bank account (gl_accounts, as the
  // Bank Accounts page edits it) — a file with no real originator is refused, never sent as zeros (AP-02).
  // Its number and branch are judged once, by validateEFTBatch below.
  const originator = (await sql`
    SELECT c.name AS company_name, ga.id AS bank_gl_id, ga.bank_account_number, ga.bank_branch_code
    FROM companies c
    LEFT JOIN gl_accounts ga ON ga.id = ${batches[0].bank_account_id as string | null}::UUID AND ga.company_id = c.id
      AND ga.is_active AND ga.account_subtype = ANY(${BANK_SUBTYPES as string[]})
    WHERE c.id = ${companyId}::UUID
  ` as Row[])[0];
  if (!originator?.bank_gl_id) {
    return apiResponse.badRequest(res, 'Batch has no active paying bank account in this company: choose one before generating the EFT file');
  }
  const header: EFTBatchHeader = {
    companyName: String(originator.company_name),
    bankAccountNumber: String(originator.bank_account_number ?? '').replace(/\D/g, ''),
    branchCode: String(originator.bank_branch_code ?? '').replace(/\D/g, ''),
    accountType: 'current',
    batchReference: String(batches[0].batch_number || batchId),
    actionDate: String(batches[0].batch_date),
  };

  const eftPayments: EFTPayment[] = payments.map((p: Row) => ({
    beneficiaryName: String(p.supplier_name || ''),
    // Digits only — the account the fingerprint verified ("6-2000000001" is 62000000001, not a padded '-2000000001').
    beneficiaryAccountNumber: String(p.bank_account_number || '').replace(/\D/g, ''),
    beneficiaryBranchCode: String(p.bank_branch_code || '').replace(/\D/g, ''),
    beneficiaryAccountType: toEFTAccountType(p.bank_account_type),
    // total_amount: `amount` is no column, so every line went out as R0.00 (R-035 PR5 round 1 LOW e).
    amount: Number(p.total_amount || 0),
    reference: String(p.reference || p.id || ''),
    beneficiaryBank: String(p.bank_name || bank),
  }));

  // Validate
  const validation = validateEFTBatch(header, eftPayments);
  if (!validation.valid) return apiResponse.badRequest(res, 'EFT validation failed (the paying bank account is set on Bank Accounts)', validation.errors);

  // Generate
  const generator = GENERATORS[bank]!;
  const fileContent = generator(header, eftPayments);
  const filename = `EFT-${bank}-${header.batchReference}-${header.actionDate}.txt`;

  log.info('EFT file generated', { bank, batchId, payments: payments.length, total: validation.totalAmount }, 'accounting');

  return apiResponse.success(res, {
    filename,
    content: fileContent,
    bank,
    paymentCount: validation.paymentCount,
    totalAmount: validation.totalAmount,
    warnings: eftTruncationWarnings(bank, header, eftPayments),
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
