/**
 * EFT File Generation API
 * POST: generate EFT file for a batch payment
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  generateStandardBankACB, generateFNBEFT, generateABSAEFT,
  generateNedbankEFT, generateCapitecEFT, validateEFTBatch,
  type EFTBatchHeader, type EFTPayment,
} from '@/modules/accounting/services/eftService';

type Row = Record<string, unknown>;

const GENERATORS: Record<string, typeof generateStandardBankACB> = {
  standard_bank: generateStandardBankACB,
  fnb: generateFNBEFT,
  absa: generateABSAEFT,
  nedbank: generateNedbankEFT,
  capitec: generateCapitecEFT,
};

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const { batchId, bank } = req.body;
  if (!batchId) return apiResponse.badRequest(res, 'batchId is required');
  if (!bank || !GENERATORS[bank]) return apiResponse.badRequest(res, `Invalid bank. Supported: ${Object.keys(GENERATORS).join(', ')}`);

  // Get batch details
  const batches = await sql`SELECT * FROM supplier_payment_batches WHERE id = ${batchId}` as Row[];
  if (!batches[0]) return apiResponse.notFound(res, 'Batch', batchId);

  // Get payments in batch
  const payments = await sql`
    SELECT sp.*, s.name as supplier_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type, s.bank_name
    FROM supplier_payments sp
    JOIN suppliers s ON sp.supplier_id = s.id
    WHERE sp.batch_id = ${batchId}
    ORDER BY sp.created_at
  ` as Row[];

  if (payments.length === 0) return apiResponse.badRequest(res, 'No payments in batch');

  // Build EFT header and payments
  const header: EFTBatchHeader = {
    companyName: String(batches[0].company_name || (await sql`SELECT name FROM companies WHERE id = ${req.companyId} LIMIT 1` as Row[])[0]?.name || 'Unknown Company'),
    bankAccountNumber: String(batches[0].bank_account_number || ''),
    branchCode: String(batches[0].bank_branch_code || ''),
    accountType: 'current',
    batchReference: String(batches[0].batch_number || batchId),
    actionDate: String(batches[0].payment_date || new Date().toISOString().split('T')[0]),
  };

  const eftPayments: EFTPayment[] = payments.map((p: any) => ({
    beneficiaryName: String(p.supplier_name || ''),
    beneficiaryAccountNumber: String(p.bank_account_number || ''),
    beneficiaryBranchCode: String(p.bank_branch_code || ''),
    beneficiaryAccountType: (p.bank_account_type || 'current') as any,
    amount: Number(p.amount || 0),
    reference: String(p.reference || p.id || ''),
    beneficiaryBank: String(p.bank_name || bank),
  }));

  // Validate
  const validation = validateEFTBatch(header, eftPayments);
  if (!validation.valid) return apiResponse.badRequest(res, 'EFT validation failed', validation.errors);

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
  });
}

export default withCompany(withErrorHandler(handler as any));
