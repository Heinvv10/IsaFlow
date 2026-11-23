/**
 * Posting a contra settlement: the WRITE half of `contraSettlementService`.
 *
 * Lifted out of the MCP tool `settle_by_contra` so a second caller (the
 * intercompany receiver-side worker) can settle a document the same way without
 * going through MCP. The posted journal is unchanged: it composes the existing
 * payment services (payment_method 'contra', migration 540).
 *
 *   AR:  createCustomerPayment -> confirmCustomerPayment
 *        DR contra account / CR Accounts Receivable.
 *   AP:  createSupplierPayment -> approveSupplierPayment -> processSupplierPayment
 *        DR Accounts Payable / CR contra account.
 *
 * `settleDocumentByContra` is the ONLY way in, and it takes raw ids, not a
 * pre-built context: immediately before the first write it checks that the
 * approver may approve, re-runs every guard in `contraSettlementService`, and
 * (AP) asks the R-035 PR5 gate. A caller therefore cannot skip a check, hand in
 * a stale or forged context, or record an approver who may not approve. Every
 * refusal is thrown BEFORE the first write, so a caller can answer it from
 * reads. `loadContraSettlementContext` stays exported for a caller that wants
 * the journal legs earlier (a dry run); its result is never an input here.
 *
 * AUTOMATION IS NOT APPROVAL. `actor.approverUserId` is the person who decided;
 * a worker must never pass its own or a system id. It is checked against the
 * Approve permission (Customers & AR for a receivable, Suppliers & AP for a
 * payable) and recorded as `approved_by` on an AP payment.
 *
 * UNTIL A STORED HUMAN DECISION RECORD EXISTS, the person who creates the
 * payment IS the approver: `actor.userId` must equal `actor.approverUserId`, and
 * that one id must hold the Approve permission. A caller cannot name someone
 * else as approver on that person's behalf. `actor.postingAgent` must be
 * `mcp:` or `system:` plus a short [a-z0-9_.:-] label: it labels the journal's
 * author and may not read as a person.
 *
 * ATOMIC, INSIDE A BOUND TRANSACTION ONLY. The writes run in one savepoint, so a
 * throw after the payment was created (or approved) leaves no draft or approved
 * contra payment behind for a caller that catches the error and commits. That
 * holds only when a request or receiver transaction is bound (`als`); without
 * one `withSavepoint` is a plain call and each write commits alone, so the
 * service refuses to run unbound (an untagged programming error).
 */

import { getSystemAccount } from '../gl/systemAccountResolver';
import { agentNewSupplierPaymentRefusal } from '../gl/approvalUnattended';
import { ApprovePermissionError, mayApprove } from './approvePermission';
import { hasWholeCents } from '@/lib/money/wholeCents';
import { withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
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

/** What `loadContraSettlementContext` returns. Output only: `settleDocumentByContra` never accepts one. */
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
  /** The person who approved. Checked here against Approve permission; recorded as `approved_by` on an AP payment. Never a worker or system id. */
  approverUserId: string;
  /** Stamped on the posted journal (`mcp:settle_by_contra:v1` for the tool). */
  postingAgent: string;
}

export interface ContraSettlementResult {
  paymentId: string;
  paymentNumber: string;
  journalEntryId: string | null;
  /** The context the posting ran against (the re-read one), for the caller's response. */
  context: ContraSettlementContext;
}

/**
 * A refusal raised before the first write: a bad input, the R-035 gate, or a
 * guard that rejected. `underlying` is the original error for a guard failure,
 * so a caller can sanitise it as it would have on its own read.
 */
export class ContraSettlementRefusal extends Error {
  constructor(message: string, readonly underlying?: unknown) {
    super(message);
    this.name = 'ContraSettlementRefusal';
  }
}

/** Every refusal THIS service raised itself, before its first write. Identity, not type: an `ApprovePermissionError` from deeper in a payment service is not in here. */
const preWriteRefusals = new WeakSet<object>();

function refuse(err: ContraSettlementRefusal | ApprovePermissionError): never {
  preWriteRefusals.add(err);
  throw err;
}

/** True only for an error `settleDocumentByContra` threw itself before any write. */
export function isContraPreWriteRefusal(err: unknown): err is ContraSettlementRefusal | ApprovePermissionError {
  return typeof err === 'object' && err !== null && preWriteRefusals.has(err);
}

/**
 * A guard's own refusal: an error carrying one of this codebase's refusal codes (the contra guards'
 * CONTRA_SETTLEMENT_REFUSED, a foreign-currency refusal), or the resolver's missing-role error. A codeless
 * error (a dropped connection, a TypeError) and a driver code (40P01, 57014) are NOT refusals.
 */
function isGuardRefusal(err: unknown): err is Error {
  if (err instanceof MissingSystemAccountError) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && REFUSAL_CODES.has(code);
}

/** A machine author only: ai:/rule: read as a person in the audit trail. Anchored both ends; no control characters. */
const MACHINE_AGENT = /^(mcp|system):[a-z0-9_.:-]{1,80}$/;

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
  subledger: Subledger;
  documentId: string;
  contraAccountId: string;
  /** Positive, whole cents. */
  amount: number;
  /** YYYY-MM-DD; must fall in an OPEN fiscal period (the payment services enforce it). */
  date: string;
  /** Why it was netted rather than paid; recorded on the payment document. */
  reason: string;
  actor: ContraSettlementActor;
}

/**
 * Check, then post. Throws `ApprovePermissionError` (approver may not approve)
 * or `ContraSettlementRefusal` (input, a guard, or the R-035 gate), both always
 * before any write and both recognisable by `isContraPreWriteRefusal`; anything
 * else is a database or payment-service failure, thrown unchanged.
 */
export async function settleDocumentByContra(
  p: SettleDocumentByContraParams,
): Promise<ContraSettlementResult> {
  const { companyId, subledger, amount, actor } = p;
  if (subledger !== 'ar' && subledger !== 'ap') {
    return refuse(new ContraSettlementRefusal('subledger must be "ar" or "ap"'));
  }
  if (!Number.isFinite(amount) || amount <= 0 || !hasWholeCents(amount)) {
    return refuse(new ContraSettlementRefusal(`amount must be a positive number of whole cents (${amount})`));
  }
  if (typeof p.reason !== 'string' || p.reason.trim() === '') {
    return refuse(new ContraSettlementRefusal('reason is required: a contra settlement moves a debt without cash, and the record has to say why.'));
  }
  if (typeof actor.postingAgent !== 'string' || !MACHINE_AGENT.test(actor.postingAgent)) {
    return refuse(new ContraSettlementRefusal('postingAgent must be "mcp:" or "system:" followed by a short lower-case label'));
  }
  if (!actor.userId || actor.userId !== actor.approverUserId) {
    return refuse(new ContraSettlementRefusal(
      'the person who creates a contra settlement must be the one who approves it: no stored approval decision exists yet to act on someone else\'s behalf',
    ));
  }
  // Programming errors, not refusals (untagged): the writes below are atomic only inside a bound transaction of this company.
  const store = als.getStore();
  if (!store?.client) throw new Error('settleDocumentByContra needs a request or receiver transaction');
  if (store.companyId !== undefined && store.companyId !== companyId) {
    throw new Error('settleDocumentByContra: the bound transaction belongs to another company');
  }
  // Round 4 / #1656: the approver is asked here, so no caller can record one who may not approve.
  if (subledger === 'ar') {
    if (!(await mayApprove(companyId, actor.approverUserId, 'customers'))) {
      return refuse(new ApprovePermissionError('customers', 'customer receipts'));
    }
  } else if (!(await mayApprove(companyId, actor.approverUserId, 'suppliers'))) {
    return refuse(new ApprovePermissionError('suppliers', 'supplier payments'));
  }

  // Re-read every guard now, whatever the caller read earlier.
  let context: ContraSettlementContext;
  try {
    context = await loadContraSettlementContext(companyId, subledger, p.documentId, p.contraAccountId, amount);
  } catch (err) {
    if (isGuardRefusal(err)) return refuse(new ContraSettlementRefusal(err.message, err));
    throw err;
  }
  // R-035 PR5 (Q6): a payable settles through a supplier payment created, approved and processed in this one call,
  // so an enforced rule that would govern it refuses here, from a read, before the first write.
  if (subledger === 'ap') {
    const refusal = await agentNewSupplierPaymentRefusal(companyId, amount);
    if (refusal) return refuse(new ContraSettlementRefusal(refusal));
  }

  // One savepoint over the writes: a throw after create/approve rolls the draft back for a caller that commits.
  const posted = await withSavepoint('settle_document_by_contra', () => postSettlement(p, context));
  return { ...posted, context };
}

type Posted = Omit<ContraSettlementResult, 'context'>;

async function postSettlement(p: SettleDocumentByContraParams, context: ContraSettlementContext): Promise<Posted> {
  const { companyId, amount, actor } = p;
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

  if (p.subledger === 'ar') {
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
