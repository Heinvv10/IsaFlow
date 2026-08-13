/**
 * Receipt-to-Journal API
 * POST /api/accounting/receipt-to-journal
 * Body: { documentId } or multipart file upload
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
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

  // Create the entry through the validated posting service.
  //
  // This used to hand-INSERT the header at `status = autoPost ? 'posted' :
  // 'draft'` and then append the legs. trg_gl_je_balanced is a BEFORE UPDATE
  // trigger, so a header landing directly in 'posted' was never balance-checked
  // — and the legs come from OCR: buildExpenseJournalFromReceipt debits
  // extracted.subtotal + extracted.vatAmount but credits extracted.totalAmount,
  // three independently-extracted numbers with no enforced invariant. A till
  // slip mixing zero-rated and standard-rated items (routine in SA retail)
  // yields subtotal + vat != total and posted a permanently unbalanced journal.
  // It was invisible only because 'auto_expense_receipt' was missing from the
  // source CHECK constraint, so every INSERT died at 23514; migration 509 adds
  // it, which makes routing through createJournalEntry a prerequisite, not a
  // tidy-up. createJournalEntry runs validateJournalEntry and resolves the
  // fiscal period from entryDate itself.
  const entry = await createJournalEntry(companyId, {
    entryDate: journalInput.entryDate,
    description: journalInput.description,
    source: 'auto_expense_receipt',
    sourceDocumentId: documentId,
    lines: journalInput.lines.map(l => ({
      glAccountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
    })),
  }, userId);

  if (autoPost) {
    await postJournalEntry(companyId, entry.id, userId);
  }

  await sql`
    UPDATE captured_documents SET status = 'matched' WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `;

  const je = { id: entry.id, status: autoPost ? 'posted' : 'draft' };

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

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
