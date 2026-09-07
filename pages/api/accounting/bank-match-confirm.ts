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

    if (candidateType === 'supplier_invoice') {
      const invRows = (await sql`
        SELECT id, supplier_id, total_amount, amount_paid, balance
        FROM supplier_invoices WHERE id = ${candidateId}::UUID AND company_id = ${companyId}
      `) as Row[];
      if (invRows.length === 0) {
        return apiResponse.notFound(res, 'Supplier invoice', candidateId);
      }
      const inv = invRows[0]!;
      const supplierId = String(inv.supplier_id);
      const currentPaid = Number(inv.amount_paid || 0);
      const invoiceTotal = Number(inv.total_amount);
      const outstandingBalance = invoiceTotal - currentPaid;

      // Create GL entry: DR Accounts Payable, CR Bank. Pass candidateId so the
      // 4-way match targets this specific invoice rather than the
      // most-recent-unpaid heuristic.
      await allocateTransaction(
        companyId, bankTransactionId, '', userId, undefined, 'supplier', supplierId,
        undefined, undefined, undefined, undefined, candidateId,
      );

      // Update invoice payment tracking
      const newPaid = currentPaid + Math.min(paymentAmount, outstandingBalance);
      const newBalance = invoiceTotal - newPaid;
      const newStatus = newBalance <= 0.01 ? 'paid' : 'partially_paid';

      await sql`
        UPDATE supplier_invoices
        SET amount_paid = ${newPaid}::NUMERIC,
            balance = ${newBalance}::NUMERIC,
            status = ${newStatus},
            updated_at = NOW()
        WHERE id = ${candidateId}::UUID AND company_id = ${companyId}::UUID
      `;

      log.info('Confirmed match: supplier invoice', {
        bankTransactionId, candidateId,
        paymentAmount, outstandingBalance, newStatus,
      }, 'accounting-api');

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

      // Create GL entry: DR Bank, CR Accounts Receivable
      await allocateTransaction(
        companyId, bankTransactionId, '', userId, undefined, 'customer', customerId,
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

      // Create GL entry: DR Accounts Payable, CR Bank
      await allocateTransaction(
        companyId, bankTransactionId, '', userId, undefined, 'supplier', supplierId,
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

    return apiResponse.success(res, { matched: true, candidateType, candidateId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Match confirmation failed';
    log.error('Failed to confirm bank match', { bankTransactionId, candidateType, candidateId, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
