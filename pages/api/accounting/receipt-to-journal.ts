/**
 * Receipt-to-Journal API
 * POST /api/accounting/receipt-to-journal
 * Body: { documentId } or multipart file upload
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  validateReceiptExtraction,
  mapMerchantToExpenseAccount,
  buildExpenseJournalFromReceipt,
  shouldAutoPostReceipt,
  parseReceiptType,
} from '@/modules/accounting/services/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const { companyId } = req as CompanyApiRequest;
  // @ts-expect-error — auth middleware attaches user
  const userId: string = req.user?.id || req.user?.userId || '';
  const { documentId } = req.body as { documentId?: string };

  if (!documentId) return apiResponse.badRequest(res, 'documentId is required');

  // Fetch captured document
  const [doc] = (await sql`
    SELECT extracted_data, status FROM captured_documents
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `) as Row[];

  if (!doc) return apiResponse.notFound(res, 'Captured document', documentId);
  if (!doc.extracted_data) return apiResponse.badRequest(res, 'Document has no extracted data');

  const extracted = doc.extracted_data as ExtractedDocument;

  // Validate
  const validation = validateReceiptExtraction(extracted);
  if (!validation.valid) {
    return apiResponse.badRequest(res, `Validation failed: ${validation.errors.join(', ')}`);
  }

  // Get GL accounts
  const glAccounts = (await sql`
    SELECT id, account_code as code, account_name as name
    FROM gl_accounts WHERE company_id = ${companyId}
    ORDER BY account_code
  `) as Row[];

  // Map merchant to expense account
  const accountSuggestion = extracted.vendorName
    ? mapMerchantToExpenseAccount(extracted.vendorName, glAccounts.map(a => ({ id: a.id, code: a.code, name: a.name })))
    : null;

  const expenseAccountId = accountSuggestion?.id || glAccounts.find(a => a.code === '5100')?.id;
  const vatInputAccountId = glAccounts.find(a => a.code === '1140')?.id;
  const bankAccountId = glAccounts.find(a => a.code === '1110')?.id;

  if (!expenseAccountId || !vatInputAccountId || !bankAccountId) {
    return apiResponse.badRequest(res, 'Required GL accounts not found (expense, VAT input, bank)');
  }

  // Build journal entry
  const journalInput = buildExpenseJournalFromReceipt(extracted, { expenseAccountId, vatInputAccountId, bankAccountId });
  const receiptType = parseReceiptType(extracted);
  const autoPost = shouldAutoPostReceipt(extracted.totalAmount || 0, extracted.confidence, { maxAmount: 5000, minConfidence: 0.85 });

  // Get fiscal period
  const [period] = (await sql`
    SELECT id FROM fiscal_periods
    WHERE company_id = ${companyId} AND start_date <= ${journalInput.entryDate}::date AND end_date >= ${journalInput.entryDate}::date
    LIMIT 1
  `) as Row[];

  // Create journal entry
  const [je] = (await sql`
    INSERT INTO gl_journal_entries (
      company_id, entry_date, fiscal_period_id, description, source, status, created_by
    ) VALUES (
      ${companyId}, ${journalInput.entryDate}::date, ${period?.id || null}::uuid,
      ${journalInput.description}, 'auto_invoice',
      ${autoPost ? 'posted' : 'draft'}, ${userId}::uuid
    ) RETURNING id, status
  `) as Row[];

  if (!je) return apiResponse.internalError(res, null, 'Failed to create journal entry');

  // Create journal lines
  for (const line of journalInput.lines) {
    await sql`
      INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${je.id}::uuid, ${line.accountId}::uuid, ${line.debit}, ${line.credit}, ${line.description})
    `;
  }

  // Link document
  await sql`
    UPDATE captured_documents SET status = 'matched' WHERE id = ${documentId}::uuid
  `;

  log.info('Receipt-to-Journal completed', {
    documentId, journalId: je.id, receiptType, autoPost,
    amount: extracted.totalAmount, merchant: extracted.vendorName,
  }, 'receipt-journal');

  return apiResponse.success(res, {
    journalEntry: { id: je.id, status: je.status },
    receiptType,
    accountSuggestion: accountSuggestion ? { code: accountSuggestion.code, name: accountSuggestion.name } : null,
    autoPosted: autoPost,
    amount: extracted.totalAmount,
    warnings: validation.warnings,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
