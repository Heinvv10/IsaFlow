/**
 * allocateTransaction's contact documents: the invoice whose source document the journal carries
 * forward (a read, before the journal), and — after the journal — the supplier payment / refund, the
 * customer refund and the receipt's own application. Moved verbatim out of bankAllocationService.ts
 * (its line cap); allocateTransaction calls each at the same point it ran before.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { recordPaymentMatch } from '../capture/fourWayMatchService';
import { recordSupplierBankPayment } from '../ap/supplierAutoAllocate';
import { recordSupplierRefund } from '../ap/supplierRefundDocument';
import { recordCustomerRefund } from '../ar/customerRefundDocument';
import { autoApplyCustomerReceipt } from '../ar/customerAutoAllocate';
import type { AutoApplyMode } from '../shared/autoAllocateStrategy';
import type { AllocationType, AllocationApplicationResult } from './bankAllocationTypes';

type Row = DbRow;

/** Carry forward source_document_id from the invoice when allocating against a known entity. */
export async function invoiceSourceDocumentOf(
  companyId: string, allocType: AllocationType, entityId?: string,
): Promise<string | null> {
  let invoiceSourceDocId: string | null = null;
  if (allocType === 'supplier' && entityId) {
    const invRows = (await sql`
      SELECT source_document_id FROM supplier_invoices
      WHERE company_id = ${companyId}::UUID AND supplier_id = ${entityId}::UUID
        AND source_document_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `) as Row[];
    invoiceSourceDocId = invRows.length > 0 && invRows[0]!.source_document_id
      ? String(invRows[0]!.source_document_id) : null;
  } else if (allocType === 'customer' && entityId) {
    const invRows = (await sql`
      SELECT source_document_id FROM customer_invoices
      WHERE company_id = ${companyId}::UUID
        AND COALESCE(client_id, customer_id) = ${entityId}::UUID
        AND source_document_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `) as Row[];
    invoiceSourceDocId = invRows.length > 0 && invRows[0]!.source_document_id
      ? String(invRows[0]!.source_document_id) : null;
  }
  return invoiceSourceDocId;
}

export interface AllocationDocumentsInput {
  companyId: string; bankTxId: string; allocType: AllocationType; entityId?: string; invoiceId?: string;
  isSpent: boolean; totalAmount: number; autoApplyMode: AutoApplyMode; bankAccountId: string;
  je: { id: string }; txDate: string; entryDesc: string; userId: string; customerPaymentId: string | null;
}

export async function recordAllocationDocuments(
  input: AllocationDocumentsInput,
): Promise<AllocationApplicationResult | undefined> {
  const {
    companyId, bankTxId, allocType, entityId, invoiceId, isSpent, totalAmount, autoApplyMode, bankAccountId,
    je, txDate, entryDesc, userId, customerPaymentId,
  } = input;
  let application: AllocationApplicationResult | undefined;

  // ── The supplier side of the cash ──────────────────────────────────────────
  //
  // TWO DIFFERENT THINGS, and conflating them is what broke this path.
  //
  // A caller that NAMES a bill is running the four-way match against that bill,
  // and `applyBankLineToSupplierInvoices` — which is the caller that names one
  // — owns the payment document and the application itself. Only the match flag
  // belongs here.
  //
  // A caller that names NO bill used to fall through to a lookup that took the
  // supplier's most recently CREATED unpaid bill and flagged it
  // `payment_matched` for the whole line, without moving `amount_paid` by a
  // cent — a settlement recorded against a bill nobody chose, on a payment
  // document that did not exist. That lookup is gone. The cash now gets the
  // document it always needed, and is applied only on the supplier's own
  // instruction (`auto_allocate_strategy`, migration 614).
  //
  // `isSpent` gates both: a refund is money coming back IN and is not a payment.
  if (allocType === 'supplier' && entityId && isSpent) {
    if (invoiceId) {
      try {
        await recordPaymentMatch(companyId, invoiceId, totalAmount);
      } catch (matchErr) {
        log.error('4-way match check failed — allocation still recorded', { bankTxId, entityId, invoiceId, error: matchErr }, 'accounting');
      }
    } else {
      // NOT caught. This writes, and a caught write is a partial commit under a
      // success response — see the header of ap/supplierAutoAllocate.ts.
      const recorded = await recordSupplierBankPayment({
        companyId,
        supplierId: entityId,
        // See the `autoApply` note on the signature: a caller that named a
        // target gets the document without the application.
        autoApply: autoApplyMode,
        bankTxId,
        bankAccountId,
        journalEntryId: je.id,
        amount: totalAmount,
        paymentDate: txDate,
        description: entryDesc,
        userId,
      });
      application = {
        autoApply: autoApplyMode,
        applications: recorded.appliedLines.map((l) => ({
          documentId: l.invoiceId, documentNumber: l.invoiceNumber, amount: l.amount,
        })),
        onAccount: recorded.unappliedRemainder,
      };
    }
  }

  // ── The refund: cash coming back ───────────────────────────────────────────
  //
  // The mirror of the arm above, and the half that did not exist. A money-IN
  // line against a supplier posted DR Bank / CR Accounts Payable and created no
  // document at all, so the control account moved, the subledger did not, and
  // the supplier's on-account credit stayed overstated by the whole refund.
  //
  // NEVER APPLIED, at any `autoApply` mode. The document is a NEGATIVE
  // remainder; "applying" it to a bill would un-pay that bill, which is a
  // correction a person makes deliberately and not something a sweep decides.
  // That is why there is no `autoApply` parameter here rather than one set to
  // 'none'.
  //
  // `invoiceId` is deliberately not consulted. On the payment arm it says a
  // caller has already claimed the document; no caller names a bill for a
  // refund, and if one ever did, the bill is not what the cash settles.
  // The customer mirror: money OUT to a customer, DR Accounts Receivable / CR
  // Bank. Same hole, same shape, opposite side — and the `!isSpent` gate on the
  // receipt insert above is what left it open. That gate is right and stays:
  // a POSITIVE receipt row for a refund is cash the company never received.
  if (allocType === 'customer' && entityId && isSpent) {
    const refund = await recordCustomerRefund({
      companyId, customerId: entityId, bankTxId, bankAccountId,
      journalEntryId: je.id, amount: totalAmount, paymentDate: txDate,
      description: entryDesc, userId,
    });
    application = { autoApply: 'none', applications: [], onAccount: refund.amount };
  }

  if (allocType === 'supplier' && entityId && !isSpent) {
    const refund = await recordSupplierRefund({
      companyId, supplierId: entityId, bankTxId, bankAccountId,
      journalEntryId: je.id, amount: totalAmount, paymentDate: txDate,
      description: entryDesc, userId,
    });
    application = {
      autoApply: 'none',
      applications: [],
      onAccount: refund.amount,
    };
  }

  // The receipt's own application, on the same rule and the same instruction.
  // The document already existed on this side; the instruction to apply it was
  // written to a column nothing read.
  //
  // `!invoiceId` and `opts?.autoApply` carry the SAME meaning as on the
  // supplier arm above, and leaving them off this arm was a real defect:
  //
  //   · `confirmReceiptMatch` passes an invoiceId and then applies the very
  //     payment this function created (it re-reads it by journal id). Applying
  //     it here first consumes the remainder, and its own
  //     `planReceiptApplication` then refuses — "only R0.00 of this receipt is
  //     unapplied" — so a bank receipt match would simply stop working for any
  //     customer with a strategy set.
  //   · `bank-match-confirm`'s customer branch names an invoice but passes no
  //     id, and writes `amount_paid` on it ABSOLUTELY from a value read before
  //     this call. If the strategy settled an older invoice, both writes stand
  //     and the subledger drops by twice the receipt. It passes
  //     `autoApply: false`.
  if (allocType === 'customer' && entityId && customerPaymentId && !isSpent && !invoiceId) {
    const applied = await autoApplyCustomerReceipt({
      companyId,
      customerId: entityId,
      paymentId: customerPaymentId,
      journalEntryId: je.id,
      amount: totalAmount,
      userId,
      autoApply: autoApplyMode,
    });
    application = {
      autoApply: autoApplyMode,
      applications: applied.appliedLines.map((l) => ({
        documentId: l.invoiceId, documentNumber: l.invoiceNumber, amount: l.amount,
      })),
      onAccount: applied.unappliedRemainder,
    };
  }

  return application;
}
