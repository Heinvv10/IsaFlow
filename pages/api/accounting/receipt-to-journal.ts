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
import {
  INPUT_VAT_DENIED_ADVICE,
  resolveVatCodeForAccount,
  VAT_CODE_STANDARD,
} from '@/modules/accounting/services/gl/inputVatDenial';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';
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

  // Ask the account itself before building. `resolveVatCodeForAccount` reads
  // the `vat_input_denied` marker on the expense account this receipt is being
  // coded to (company-scoped, one query) and coerces the claim away for an
  // unattended caller — which this is, since the receipt auto-posts under a
  // confidence gate with nobody looking at it. The builder ORs that with its
  // merchant heuristic, so a restaurant the regex does not recognise is still
  // caught whenever the account carries the flag.
  const accountDenial = await resolveVatCodeForAccount(
    companyId,
    expenseAccountId,
    VAT_CODE_STANDARD,
    { documentId, source: 'receipt_to_journal' },
  );

  // Build journal entry
  const journalInput = buildExpenseJournalFromReceipt(
    extracted,
    { expenseAccountId, vatInputAccountId, bankAccountId },
    { accountVatDenied: accountDenial.denied },
  );
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
  // Drop zero-value legs. buildExpenseJournalFromReceipt always emits a VAT
  // leg, and a zero-rated or exempt receipt (bank charges, basic foodstuffs, a
  // foreign supplier) extracts vatAmount = 0 — validateReceiptExtraction only
  // warns on a NULL vatAmount, not a zero one. validateJournalLine rejects a
  // line with neither debit nor credit, so passing it through would 500 every
  // zero-VAT receipt. Dropping it cannot unbalance the entry: the leg is worth
  // nothing on both sides. Same guard as expenseClaimService's
  // `if (netAmount === 0) continue`.
  const postableLines = journalInput.lines
    .filter(l => l.debit !== 0 || l.credit !== 0)
    .map(l => ({
      glAccountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
      vatType: l.vatType,
    }));

  // Check the extraction actually balances BEFORE calling createJournalEntry.
  // The legs come from OCR — subtotal, vatAmount and totalAmount are extracted
  // independently with no enforced invariant, and a till slip mixing zero-rated
  // and standard-rated items (routine in SA retail) yields
  // subtotal + vat != total. createJournalEntry would reject it, but as a throw
  // that withErrorHandler masks into a generic 500, leaving the operator with
  // "internal error" on a document that is merely mis-extracted. Answering 400
  // here is safe precisely because nothing has been written yet — the route
  // only reads up to this point. (After this line a 4xx would COMMIT a partial
  // write, which is why the failures below propagate instead.)
  const preCheck = validateJournalEntry(postableLines);
  if (!preCheck.valid) {
    return apiResponse.badRequest(
      res,
      `Receipt does not balance — check the extracted amounts: ${preCheck.errors.join('; ')}`,
    );
  }

  const entry = await createJournalEntry(companyId, {
    entryDate: journalInput.entryDate,
    description: journalInput.description,
    source: 'auto_expense_receipt',
    sourceDocumentId: documentId,
    lines: postableLines,
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
    inputVatDenied: journalInput.inputVatDenied,
    warnings: journalInput.inputVatDenied
      ? [...validation.warnings, INPUT_VAT_DENIED_ADVICE]
      : validation.warnings,
  });
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
