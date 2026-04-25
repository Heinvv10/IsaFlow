/**
 * Receipt-to-Journal API
 * POST /api/accounting/receipt-to-journal
 * Body: { documentId } or multipart file upload
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import {
  validateReceiptExtraction,
  mapMerchantToExpenseAccount,
  buildExpenseJournalFromReceipt,
  shouldAutoPostReceipt,
  parseReceiptType,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);

  const { companyId } = req;
  const userId: string = req.user?.id || '';
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

  // Get GL accounts for merchant-to-expense mapping
  const glAccounts = (await sql`
    SELECT id, account_code as code, account_name as name
    FROM gl_accounts WHERE company_id = ${companyId}
    ORDER BY account_code
  `) as Row[];

  // Resolve system accounts via default-accounts config (not hard-coded GL codes)
  let vatInputAccountId: string;
  let bankAccountId: string;
  let defaultExpenseAccountId: string;
  try {
    [vatInputAccountId, bankAccountId, defaultExpenseAccountId] = await Promise.all([
      getSystemAccountId('vat_input', companyId),
      getSystemAccountId('bank', companyId),
      getSystemAccountId('default_expense', companyId),
    ]);
  } catch {
    return apiResponse.badRequest(res, 'Default accounts not configured. Set VAT Input, Bank, and Expense accounts under Accounting > Default Accounts.');
  }

  // Map merchant to a specific expense account; fall back to configured default
  const accountSuggestion = extracted.vendorName
    ? mapMerchantToExpenseAccount(extracted.vendorName, glAccounts.map(a => ({ id: a.id, code: a.code, name: a.name })))
    : null;
  const expenseAccountId = accountSuggestion?.id ?? defaultExpenseAccountId;

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

  // Create journal entry + lines + document link atomically
  const je = await withTransaction(async (tx) => {
    const rows = (await tx`
      INSERT INTO gl_journal_entries (
        company_id, entry_date, fiscal_period_id, description, source, status, created_by
      ) VALUES (
        ${companyId}, ${journalInput.entryDate}::date, ${period?.id || null}::uuid,
        ${journalInput.description}, 'auto_expense_receipt',
        ${autoPost ? 'posted' : 'draft'}, ${userId}
      ) RETURNING id, status
    `) as Row[];

    if (!rows[0]) throw new Error('Failed to create journal entry');
    const entry = rows[0] as Row;

    for (const line of journalInput.lines) {
      await tx`
        INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description, company_id)
        VALUES (${entry.id}::uuid, ${line.accountId}::uuid, ${line.debit}, ${line.credit}, ${line.description}, ${companyId}::uuid)
      `;
    }

    await tx`
      UPDATE captured_documents SET status = 'matched' WHERE id = ${documentId}::uuid AND company_id = ${companyId}
    `;

    return entry;
  });

  if (!je) return apiResponse.internalError(res, null, 'Failed to create journal entry');

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

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
