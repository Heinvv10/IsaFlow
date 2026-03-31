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

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  allocateTransaction,
  matchTransaction,
} from '@/modules/accounting/services/bankReconciliationService';
import type { CandidateType } from '@/modules/accounting/types/bank-match.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const {
    bankTransactionId,
    candidateType,
    candidateId,
  } = req.body as {
    bankTransactionId?: string;
    candidateType?: CandidateType;
    candidateId?: string;
  };

  const { companyId } = req as CompanyApiRequest;
  // @ts-expect-error — auth middleware attaches user
  const userId: string = req.user?.id ?? req.user?.userId ?? 'system';

  if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId is required');
  if (!candidateType) return apiResponse.badRequest(res, 'candidateType is required');
  if (!candidateId) return apiResponse.badRequest(res, 'candidateId is required');

  const validTypes: CandidateType[] = ['supplier_invoice', 'customer_invoice', 'purchase_order', 'journal_line'];
  if (!validTypes.includes(candidateType)) {
    return apiResponse.badRequest(res, `candidateType must be one of: ${validTypes.join(', ')}`);
  }

  try {
    // Get the bank transaction amount for partial payment calculations
    const txRows = (await sql`
      SELECT amount FROM bank_transactions WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
    `) as Row[];
    if (txRows.length === 0) {
      return apiResponse.notFound(res, 'Bank transaction', bankTransactionId);
    }
    const paymentAmount = Math.abs(Number(txRows[0]!.amount));

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

      // Create GL entry: DR Accounts Payable, CR Bank
      await allocateTransaction(
        companyId, bankTransactionId, '', userId, undefined, 'supplier', supplierId,
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
        WHERE id = ${candidateId}::UUID
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
        WHERE id = ${candidateId}::UUID
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
        WHERE id = ${candidateId}::UUID
      `;

      log.info('Confirmed match: purchase order', { bankTransactionId, candidateId }, 'accounting-api');

    } else {
      // journal_line — match to existing GL entry
      await matchTransaction(companyId, bankTransactionId, candidateId);
      log.info('Confirmed match: journal line', { bankTransactionId, candidateId }, 'accounting-api');
    }

    return apiResponse.success(res, { matched: true, candidateType, candidateId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Match confirmation failed';
    const stack = err instanceof Error ? err.stack : '';
    console.error('[MATCH-CONFIRM-ERROR]', message, stack);
    log.error('Failed to confirm bank match', { bankTransactionId, candidateType, candidateId, error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
