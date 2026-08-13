/**
 * POST /api/accounting/capture/[id]/post-expense
 *
 * Second post path for the capture inbox: creates an expense claim (when an
 * employeeId is provided) or posts a direct GL journal entry (anonymous till
 * slip / petty-cash route) instead of a supplier invoice.
 *
 * Body: { employeeId?: string, costCentreId?: string, glAccountId?: string }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import {
  mapMerchantToExpenseAccount,
  buildExpenseJournalFromReceipt,
  shouldAutoPostReceipt,
  type ReceiptAccountMapping,
} from '@/modules/accounting/services/bank/receiptToJournalService';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  createClaim,
  submitClaim,
  type ExpenseClaimLine,
} from '@/modules/accounting/services/expense/expenseClaimService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

type Row = Record<string, unknown>;

interface PostExpenseBody {
  employeeId?: string;
  costCentreId?: string;
  glAccountId?: string;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const userId = req.user?.id ?? '';
  const eventId = req.query.id as string;

  if (!eventId) return apiResponse.badRequest(res, 'eventId is required');

  // ------------------------------------------------------------------
  // 1. Load event + extracted document (same query shape as post.ts)
  // ------------------------------------------------------------------
  const eventRows = await sql`
    SELECT ce.id AS event_id, ce.status AS event_status,
           ce.captured_document_id, cd.extracted_data
    FROM capture_events ce
    JOIN captured_documents cd ON cd.id = ce.captured_document_id
    WHERE ce.id = ${eventId}::uuid
      AND ce.company_id = ${companyId}
      AND cd.company_id = ${companyId}
    LIMIT 1
  ` as Row[];

  if (eventRows.length === 0) {
    return apiResponse.notFound(res, 'Capture event', eventId);
  }

  const event = eventRows[0]!;

  if (event.event_status === 'posted') {
    return apiResponse.badRequest(res, 'Event already posted');
  }

  if (!event.extracted_data) {
    return apiResponse.badRequest(res, 'Document has no extracted data — extraction may still be in progress');
  }

  const documentId = event.captured_document_id as string;
  const extracted = event.extracted_data as ExtractedDocument;

  const { employeeId, costCentreId, glAccountId: bodyGlAccountId } = req.body as PostExpenseBody;

  // ------------------------------------------------------------------
  // 2. Resolve GL expense account
  // ------------------------------------------------------------------
  let resolvedGlAccountId: string;

  if (bodyGlAccountId) {
    // Caller specified explicit GL account — verify it belongs to this company
    const acctRows = await sql`
      SELECT id FROM gl_accounts
      WHERE id = ${bodyGlAccountId}::uuid AND company_id = ${companyId}
      LIMIT 1
    ` as Row[];
    if (acctRows.length === 0) {
      return apiResponse.badRequest(res, 'glAccountId not found for this company');
    }
    resolvedGlAccountId = bodyGlAccountId;
  } else if (extracted.vendorName) {
    // Try merchant-pattern lookup
    const allAccts = await sql`
      SELECT id, account_code AS code, account_name AS name
      FROM gl_accounts
      WHERE company_id = ${companyId}
        AND is_active = true
    ` as Row[];
    const mappings: ReceiptAccountMapping[] = allAccts.map(a => ({
      id: a.id as string,
      code: a.code as string,
      name: a.name as string,
    }));
    const suggestion = mapMerchantToExpenseAccount(extracted.vendorName, mappings);
    resolvedGlAccountId = suggestion?.id ?? await getSystemAccountId('default_expense', companyId);
  } else {
    resolvedGlAccountId = await getSystemAccountId('default_expense', companyId);
  }

  // Always resolve VAT Input account — required for correct journal
  let vatInputAccountId: string;
  try {
    vatInputAccountId = await getSystemAccountId('vat_input', companyId);
  } catch {
    return apiResponse.badRequest(res, 'VAT Input system account not configured — set it up in Default Accounts');
  }

  // ------------------------------------------------------------------
  // 3a. Employee path → create expense claim + auto-submit
  // ------------------------------------------------------------------
  if (employeeId) {
    const total = extracted.totalAmount ?? 0;
    const vatAmt = extracted.vatAmount ?? Math.round((total / 1.15 * 0.15) * 100) / 100;
    const lineDate = extracted.date ?? new Date().toISOString().slice(0, 10);

    const line: ExpenseClaimLine = {
      lineDate,
      description: extracted.vendorName ?? 'Expense receipt',
      merchant: extracted.vendorName ?? null,
      amount: total,
      vatAmount: vatAmt,
      vatCode: null,
      glAccountId: resolvedGlAccountId,
      costCentreId: costCentreId ?? null,
      projectId: null,
      sourceDocumentId: documentId,
      kmTravelled: null,
      kmRate: null,
      mileageFrom: null,
      mileageTo: null,
    };

    const claim = await createClaim({
      companyId,
      employeeId,
      claimDate: lineDate,
      title: extracted.vendorName ? `Expense: ${extracted.vendorName}` : 'Expense receipt',
      createdBy: userId,
      lines: [line],
    });

    // Auto-submit so it enters the approval queue immediately
    const submitted = await submitClaim(claim.id, companyId);

    // Stamp capture records atomically
    await withTransaction(async (tx) => {
      await tx`
        UPDATE captured_documents
        SET status = 'matched', document_category = 'expense', updated_at = NOW()
        WHERE id = ${documentId}::uuid AND company_id = ${companyId}
      `;
      await tx`
        UPDATE capture_events
        SET status = 'posted',
            posted_by = ${userId},
            posted_at = NOW(),
            document_category = 'expense',
            resolved_employee_id = ${employeeId}::uuid,
            resolved_gl_account_id = ${resolvedGlAccountId}::uuid,
            resolved_cost_centre_id = ${costCentreId ?? null}::uuid,
            updated_at = NOW()
        WHERE id = ${eventId}::uuid AND company_id = ${companyId}
      `;
    });

    log.info('Capture event posted as expense claim', {
      eventId, documentId, claimId: claim.id, employeeId,
    }, 'capture-post-expense');

    return apiResponse.success(res, {
      expenseClaim: { id: submitted?.id ?? claim.id, claimNumber: submitted?.claimNumber ?? claim.claimNumber },
      merchant: extracted.vendorName,
      amount: extracted.totalAmount,
    });
  }

  // ------------------------------------------------------------------
  // 3b. Anonymous path → direct GL journal (petty cash / company card)
  // ------------------------------------------------------------------
  const total = extracted.totalAmount ?? 0;
  const entryDate = extracted.date ?? new Date().toISOString().slice(0, 10);

  // Build journal lines from receipt
  const bankAccountId = await getSystemAccountId('bank', companyId);

  const journalInput = buildExpenseJournalFromReceipt(extracted, {
    expenseAccountId: resolvedGlAccountId,
    vatInputAccountId,
    bankAccountId,
  });

  const jeEntry = await createJournalEntry(
    companyId,
    {
      entryDate,
      description: journalInput.description,
      source: 'auto_expense_receipt',
      sourceDocumentId: documentId,
      // Drop zero-value legs — buildExpenseJournalFromReceipt always emits a
      // VAT leg, and a zero-rated or exempt receipt extracts vatAmount = 0,
      // which validateJournalLine rejects. Dropping it cannot unbalance the
      // entry. Pre-existing here (this path was already dead on the source
      // CHECK, so it never surfaced); fixed alongside receipt-to-journal.ts,
      // which migration 509 makes live.
      lines: journalInput.lines
        .filter(l => l.debit !== 0 || l.credit !== 0)
        .map(l => ({
          glAccountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
          costCenterId: costCentreId,
        })),
    },
    userId,
  );

  // Auto-post when the receipt passes the gate (under R5 000 + high confidence)
  const confidence = typeof extracted.confidence === 'number' ? extracted.confidence : 0;
  const autoPost = shouldAutoPostReceipt(total, confidence, { maxAmount: 5000, minConfidence: 0.80 });

  let jeStatus = jeEntry.status;
  if (autoPost) {
    try {
      await postJournalEntry(jeEntry.id, userId, companyId);
      jeStatus = 'posted';
    } catch (postErr) {
      log.warn('Auto-post of expense receipt JE failed — left as draft', {
        eventId, jeId: jeEntry.id, error: postErr,
      }, 'capture-post-expense');
    }
  }

  // Stamp capture records atomically
  await withTransaction(async (tx) => {
    await tx`
      UPDATE captured_documents
      SET status = 'matched', document_category = 'expense', updated_at = NOW()
      WHERE id = ${documentId}::uuid AND company_id = ${companyId}
    `;
    await tx`
      UPDATE capture_events
      SET status = 'posted',
          posted_by = ${userId},
          posted_at = NOW(),
          document_category = 'expense',
          resolved_gl_account_id = ${resolvedGlAccountId}::uuid,
          resolved_cost_centre_id = ${costCentreId ?? null}::uuid,
          updated_at = NOW()
      WHERE id = ${eventId}::uuid AND company_id = ${companyId}
    `;
  });

  log.info('Capture event posted as direct GL expense', {
    eventId, documentId, jeId: jeEntry.id, autoPost, jeStatus,
  }, 'capture-post-expense');

  return apiResponse.success(res, {
    journalEntry: { id: jeEntry.id, status: jeStatus },
    merchant: extracted.vendorName,
    amount: extracted.totalAmount,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
