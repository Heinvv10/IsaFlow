/**
 * Posting a contra settlement: the WRITE half of `contraSettlementService`.
 *
 * Lifted out of the MCP tool `settle_by_contra` so a second caller (the
 * intercompany receiver-side worker) can settle a document the same way without
 * going through MCP. Behaviour is unchanged: it composes the existing payment
 * services (payment_method 'contra', migration 540), so the posted journal is
 * exactly what the tool always posted.
 *
 *   AR:  createCustomerPayment -> confirmCustomerPayment
 *        DR contra account / CR Accounts Receivable.
 *   AP:  createSupplierPayment -> approveSupplierPayment -> processSupplierPayment
 *        DR Accounts Payable / CR contra account.
 *
 * Two steps, so a caller can answer every refusal from READS before the first
 * write (a refusal returned after a write frees the idempotency key for a retry
 * that settles the document twice):
 *
 *   1. `loadContraSettlementContext`  READ-ONLY. Runs every guard in
 *      `contraSettlementService` and resolves the control account.
 *   2. `settleDocumentByContra`       WRITES. Takes that context, so a settlement
 *      cannot be posted without the guards having run.
 *
 * AUTHORITY IS THE CALLER'S. This module does not decide who may approve: the
 * MCP tool asks `mayApprove` (Customers / Suppliers & AP) and the R-035 PR5
 * unattended-payment refusal before it calls here. The `actor` says who is
 * recorded as creator, approver and poster, and which posting agent stamps the
 * journal.
 */

import { getSystemAccount } from '../gl/systemAccountResolver';
import {
  assertContraAccountUsable,
  loadContraDocument,
  type ContraAccountCheck,
  type ContraDocument,
  type Subledger,
} from './contraSettlementService';
import { createCustomerPayment, confirmCustomerPayment } from '../ar/customerPaymentService';
import {
  createSupplierPayment,
  approveSupplierPayment,
  processSupplierPayment,
} from '../ap/supplierPaymentService';

/** One side of the journal, for the dry run and the response text. */
export interface ContraLeg {
  id: string;
  code: string;
  name: string;
}

export interface ContraSettlementContext {
  subledger: Subledger;
  contra: ContraAccountCheck;
  document: ContraDocument;
  /** DR contra / CR AR for a receivable; DR AP / CR contra for a payable. */
  debit: ContraLeg;
  credit: ContraLeg;
}

/** Who the settlement is recorded against, and how the journal is stamped. */
export interface ContraSettlementActor {
  /** Creates the payment and (AR) confirms / (AP) processes it. */
  userId: string;
  /** Recorded as `approved_by` on an AP payment. The caller must have checked this user may approve. */
  approverUserId: string;
  /** Stamped on the posted journal (`mcp:settle_by_contra:v1` for the tool). */
  postingAgent: string;
}

export interface ContraSettlementResult {
  paymentId: string;
  paymentNumber: string;
  journalEntryId: string | null;
}

/**
 * Read and validate everything a settlement depends on. READ-ONLY. Throws the
 * guard's own error, unchanged, for the caller to report.
 */
export async function loadContraSettlementContext(
  companyId: string,
  subledger: Subledger,
  documentId: string,
  contraAccountId: string,
  amount: number,
): Promise<ContraSettlementContext> {
  const [contra, document, control] = await Promise.all([
    assertContraAccountUsable(companyId, subledger, contraAccountId),
    loadContraDocument(companyId, subledger, documentId, amount),
    getSystemAccount(subledger === 'ar' ? 'receivable' : 'payable', companyId),
  ]);
  const contraLeg: ContraLeg = { id: contra.accountId, code: contra.accountCode, name: contra.accountName };
  const controlLeg: ContraLeg = { id: control.id, code: control.accountCode ?? '', name: control.accountName ?? '' };
  return {
    subledger,
    contra,
    document,
    debit: subledger === 'ar' ? contraLeg : controlLeg,
    credit: subledger === 'ar' ? controlLeg : contraLeg,
  };
}

export interface SettleDocumentByContraParams {
  companyId: string;
  actor: ContraSettlementActor;
  context: ContraSettlementContext;
  amount: number;
  /** YYYY-MM-DD; must fall in an OPEN fiscal period (the payment services enforce it). */
  date: string;
  /** Why it was netted rather than paid; recorded on the payment document. */
  reason: string;
}

/** WRITES. Posts the settlement through the payment services and returns the payment and journal ids. */
export async function settleDocumentByContra(
  p: SettleDocumentByContraParams,
): Promise<ContraSettlementResult> {
  const { companyId, actor, context, amount } = p;
  const base = {
    paymentDate: p.date,
    totalAmount: amount,
    paymentMethod: 'contra' as const,
    // The contra account rides in the bank-account column: both payment services
    // resolve their cash leg from it with no subtype check.
    bankAccountId: context.contra.accountId,
    description: `Contra settlement — ${p.reason}`,
    allocations: [{ invoiceId: context.document.documentId, amount }],
  };

  if (context.subledger === 'ar') {
    const payment = await createCustomerPayment(
      companyId, { ...base, clientId: context.document.counterpartyId }, actor.userId,
    );
    const confirmed = await confirmCustomerPayment(companyId, payment.id, actor.userId, {
      postingAgent: actor.postingAgent,
    });
    return {
      paymentId: confirmed.id,
      paymentNumber: confirmed.paymentNumber,
      journalEntryId: confirmed.glJournalEntryId ?? null,
    };
  }

  const payment = await createSupplierPayment(
    companyId, { ...base, supplierId: context.document.counterpartyId }, actor.userId,
  );
  await approveSupplierPayment(companyId, payment.id, actor.approverUserId);
  const processed = await processSupplierPayment(companyId, payment.id, actor.userId, {
    postingAgent: actor.postingAgent,
  });
  return {
    paymentId: processed.id,
    paymentNumber: processed.paymentNumber,
    journalEntryId: processed.glJournalEntryId ?? null,
  };
}
