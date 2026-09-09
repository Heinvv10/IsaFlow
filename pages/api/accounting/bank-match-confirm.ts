/**
 * Bank Match Confirm API
 * POST /api/accounting/bank-match-confirm
 * Body: { bankTransactionId, candidateType, candidateId }
 *
 * Confirms a manual match selection from the FindMatchModal.
 * Creates proper double-entry journal entries and handles partial payments:
 *
 * Customer invoice (receipt):  DR Bank, CR Accounts Receivable
 * Supplier invoice (payment):  DR Accounts Payable, CR Bank
 * Purchase order (payment):    DR Accounts Payable, CR Bank
 * Journal line:                Direct match to existing GL entry
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  allocateTransaction,
  matchTransaction,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import {
  confirmSupplierInvoiceMatch,
} from '@/modules/accounting/services/bank/confirmSupplierMatch';
import {
  signMismatchReason,
  type SettlementKind,
} from '@/modules/accounting/services/bank/bankLineDirection';
type Row = Record<string, unknown>;

const BodySchema = z.object({
  bankTransactionId: UUID,
  candidateType: z.enum([
    'supplier_invoice', 'customer_invoice', 'purchase_order',
    'journal_line', 'bank_transfer',
  ]),
  candidateId: UUID,
}).strict();


async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { bankTransactionId, candidateType, candidateId } = parsed.data;

  const { companyId } = req;
  const userId: string = req.user?.id ?? 'system';

  try {
    // Get the bank transaction amount for partial payment calculations
    const txRows = (await sql`
      SELECT amount FROM bank_transactions WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    `) as Row[];
    if (txRows.length === 0) {
      return apiResponse.notFound(res, 'Bank transaction', bankTransactionId);
    }
    // SIGNED first, magnitude second. This route settles the document with
    // arithmetic of its own (`amount_paid += min(paymentAmount, outstanding)`)
    // which has no idea which way the money went, and `allocateTransaction` now
    // posts the journal in the direction the sign implies. Unguarded, a refund
    // matched here raises the AP liability in the GL while this route reduces
    // it in the subledger — control and subledger differ by TWICE the line,
    // behind a match a human confirmed on screen.
    //
    // Refused rather than reinterpreted, and BEFORE the first write: `withAuth`
    // decides COMMIT vs ROLLBACK on `statusCode >= 500`, so a 400 raised after
    // a write commits it. `bank_transfer` and `journal_line` are absent from
    // this map deliberately — they tie a line to a journal that already exists
    // and settle no document, so they have no direction to contradict.
    const signedAmount = Number(txRows[0]!.amount);
    const settles: Partial<Record<typeof candidateType, SettlementKind>> = {
      supplier_invoice: 'supplier',
      purchase_order: 'supplier',
      customer_invoice: 'customer',
    };
    const settlementKind = settles[candidateType];
    if (settlementKind) {
      const wrongWay = signMismatchReason(settlementKind, signedAmount);
      if (wrongWay) return apiResponse.badRequest(res, wrongWay);
    }
    const paymentAmount = Math.abs(signedAmount);
    // Named in the response when a branch creates a payment document, so the
    // screen can say which one settled the line.
    let settlement: { supplierPaymentId: string; paymentNumber: string; allocated: number } | undefined;

    if (candidateType === 'supplier_invoice') {
      // The whole arm lives in `confirmSupplierInvoiceMatch`: what it may
      // settle, what it must refuse, and — load-bearing — the fact that every
      // refusal is decided from READS, before the first write, because a 4xx
      // raised after one COMMITs it.
      const outcome = await confirmSupplierInvoiceMatch(
        companyId, bankTransactionId, candidateId, userId, paymentAmount,
      );
      if (!outcome.ok) {
        return outcome.kind === 'not_found'
          ? apiResponse.notFound(res, 'Supplier invoice', candidateId)
          : apiResponse.badRequest(res, outcome.message);
      }
      settlement = {
        supplierPaymentId: outcome.supplierPaymentId,
        paymentNumber: outcome.paymentNumber,
        allocated: outcome.allocated,
      };

    } else if (candidateType === 'customer_invoice') {
      const ciRows = (await sql`
        SELECT id, customer_id, total_amount, amount_paid
        FROM customer_invoices WHERE id = ${candidateId}::UUID AND company_id = ${companyId}
      `) as Row[];
      if (ciRows.length === 0) {
        return apiResponse.notFound(res, 'Customer invoice', candidateId);
      }
      const ci = ciRows[0]!;
      const customerId = String(ci.customer_id);
      const currentPaid = Number(ci.amount_paid || 0);
      const invoiceTotal = Number(ci.total_amount);
      const outstandingBalance = invoiceTotal - currentPaid;

      // Create GL entry: DR Bank, CR Accounts Receivable.
      //
      // `autoApply: false`: this branch settles `candidateId` itself, with the
      // absolute `amount_paid` write below, computed from a balance read
      // BEFORE this call. Letting the customer's auto-allocate strategy also
      // apply the receipt would reduce the subledger twice for one deposit —
      // once on whichever invoice the strategy picked, once here — while the
      // AR control account moved only by the line.
      await allocateTransaction(
        companyId, bankTransactionId, '', userId, undefined, 'customer', customerId,
        undefined, undefined, undefined, undefined, undefined, { autoApply: false },
      );

      // Update invoice payment tracking
      const newPaid = currentPaid + Math.min(paymentAmount, outstandingBalance);
      const newStatus = (newPaid >= invoiceTotal - 0.01) ? 'paid' : 'partially_paid';

      await sql`
        UPDATE customer_invoices
        SET amount_paid = ${newPaid}::NUMERIC,
            status = ${newStatus},
            paid_at = ${newStatus === 'paid' ? new Date().toISOString() : null},
            updated_at = NOW()
        WHERE id = ${candidateId}::UUID AND company_id = ${companyId}::UUID
      `;

      log.info('Confirmed match: customer invoice', {
        bankTransactionId, candidateId,
        paymentAmount, outstandingBalance, newStatus,
      }, 'accounting-api');

    } else if (candidateType === 'purchase_order') {
      const poRows = (await sql`
        SELECT id, supplier_id, total FROM purchase_orders WHERE id = ${candidateId}::UUID AND company_id = ${companyId}
      `) as Row[];
      if (poRows.length === 0) {
        return apiResponse.notFound(res, 'Purchase order', candidateId);
      }
      const supplierId = String(poRows[0]!.supplier_id);

      // Create GL entry: DR Accounts Payable, CR Bank.
      //
      // `autoApply: false`: the user confirmed this line against a PURCHASE
      // ORDER, and a purchase order is not a bill. The payment document is
      // created — the cash left the bank and needs one — but the supplier's
      // auto-allocate strategy is NOT run, because settling some unrelated
      // open bill with money the user just told us was for this PO would
      // contradict the match they confirmed. The cash stays unapplied and
      // `list_unapplied_payments` reports it against the bill it eventually
      // belongs to.
      await allocateTransaction(
        companyId, bankTransactionId, '', userId, undefined, 'supplier', supplierId,
        undefined, undefined, undefined, undefined, undefined, { autoApply: false },
      );

      await sql`
        UPDATE purchase_orders SET status = 'paid', updated_at = NOW()
        WHERE id = ${candidateId}::UUID AND company_id = ${companyId}::UUID
      `;

      log.info('Confirmed match: purchase order', { bankTransactionId, candidateId }, 'accounting-api');

    } else if (candidateType === 'bank_transfer') {
      // Opposite leg of an inter-account transfer. The transfer JE was posted
      // when the source bank's line was allocated — no new JE here, just tie
      // this bank tx to that JL and mirror the transfer metadata so drill-
      // through works from either side.
      const jlRows = (await sql`
        SELECT jl.journal_entry_id, jl.gl_account_id, je.source
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.id = ${candidateId}::UUID AND jl.company_id = ${companyId}::UUID
      `) as Row[];
      if (jlRows.length === 0) {
        return apiResponse.notFound(res, 'Journal line', candidateId);
      }
      const jl = jlRows[0]!;
      if (String(jl.source) !== 'auto_bank_transfer') {
        return apiResponse.badRequest(res, 'Selected journal line is not a bank transfer');
      }
      const transferJeId = String(jl.journal_entry_id);

      // Counterparty = the OTHER bank GL account on this JE (not the one for
      // this bank tx).
      const otherLegRows = (await sql`
        SELECT jl2.gl_account_id, ga.account_code, ga.account_name
        FROM gl_journal_lines jl2
        JOIN gl_accounts ga ON ga.id = jl2.gl_account_id
        WHERE jl2.journal_entry_id = ${transferJeId}::UUID
          AND jl2.company_id = ${companyId}::UUID
          AND jl2.id <> ${candidateId}::UUID
        LIMIT 1
      `) as Row[];
      const counterpartyId = otherLegRows.length > 0 ? String(otherLegRows[0]!.gl_account_id) : null;
      const counterpartyLabel = otherLegRows.length > 0
        ? `${String(otherLegRows[0]!.account_code)} ${String(otherLegRows[0]!.account_name)}`
        : null;

      await matchTransaction(companyId, bankTransactionId, candidateId);
      await sql`
        UPDATE bank_transactions
        SET allocation_type = 'transfer',
            allocated_entity_name = ${counterpartyLabel},
            counterparty_account_id = ${counterpartyId}::UUID,
            transfer_journal_entry_id = ${transferJeId}::UUID,
            updated_at = NOW()
        WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}::UUID
      `;
      log.info('Confirmed match: bank transfer (opposite leg)', {
        bankTransactionId, candidateId, transferJeId, counterpartyId,
      }, 'accounting-api');

    } else {
      // journal_line — match to existing GL entry
      await matchTransaction(companyId, bankTransactionId, candidateId);
      log.info('Confirmed match: journal line', { bankTransactionId, candidateId }, 'accounting-api');
    }

    return apiResponse.success(res, { matched: true, candidateType, candidateId, ...settlement });
  } catch (err) {
    // 500, not 400. Every throw reachable here happens at or after
    // `allocateTransaction`, which has already posted a journal, touched
    // `bank_transactions` and may have written a payment document. `withAuth`
    // decides COMMIT vs ROLLBACK on `statusCode >= 500`, so answering 400 here
    // committed exactly the half-finished match this route must not leave
    // behind. The pre-write refusals above are plain `return`s and keep their
    // 4xx.
    const message = err instanceof Error ? err.message : 'Match confirmation failed';
    log.error('Failed to confirm bank match', { bankTransactionId, candidateType, candidateId, error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
