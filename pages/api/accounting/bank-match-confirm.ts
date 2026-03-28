/**
 * Bank Match Confirm API
 * POST /api/accounting/bank-match-confirm
 * Body: { bankTransactionId, candidateType, candidateId }
 * Confirms a manual match selection from the FindMatchModal.
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

  const validTypes: CandidateType[] = ['supplier_invoice', 'purchase_order', 'journal_line'];
  if (!validTypes.includes(candidateType)) {
    return apiResponse.badRequest(res, `candidateType must be one of: ${validTypes.join(', ')}`);
  }

  try {
    if (candidateType === 'supplier_invoice') {
      // Look up the supplier invoice to derive the supplier entity id
      const invRows = (await sql`
        SELECT id, supplier_id, total_amount FROM supplier_invoices WHERE id = ${candidateId}::UUID AND company_id = ${companyId}
      `) as Row[];
      if (invRows.length === 0) {
        return apiResponse.notFound(res, 'Supplier invoice', candidateId);
      }
      const inv = invRows[0]!;
      const supplierId = String(inv.supplier_id);

      // Allocate the bank transaction against the AP account for this supplier
      await allocateTransaction(
        companyId,
        bankTransactionId,
        '', // contraAccountId unused when allocType is 'supplier'
        userId,
        undefined,
        'supplier',
        supplierId,
      );

      // Mark invoice as paid
      await sql`
        UPDATE supplier_invoices SET status = 'paid', updated_at = NOW()
        WHERE id = ${candidateId}::UUID
      `;

      log.info('Confirmed match: supplier invoice', { bankTransactionId, candidateId }, 'accounting-api');
    } else if (candidateType === 'purchase_order') {
      // Look up the PO to derive the supplier entity id
      const poRows = (await sql`
        SELECT id, supplier_id, total_amount FROM purchase_orders WHERE id = ${candidateId}::UUID
      `) as Row[];
      if (poRows.length === 0) {
        return apiResponse.notFound(res, 'Purchase order', candidateId);
      }
      const po = poRows[0]!;
      const supplierId = String(po.supplier_id);

      // Allocate against AP account for this supplier
      await allocateTransaction(
        companyId,
        bankTransactionId,
        '',
        userId,
        undefined,
        'supplier',
        supplierId,
      );

      // Link PO to bank transaction and mark as paid
      await sql`
        UPDATE purchase_orders
        SET bank_transaction_id = ${bankTransactionId}::UUID,
            status = 'paid',
            updated_at = NOW()
        WHERE id = ${candidateId}::UUID
      `;

      // Link bank transaction back to the PO
      await sql`
        UPDATE bank_transactions
        SET linked_po_id = ${candidateId}::UUID, updated_at = NOW()
        WHERE id = ${bankTransactionId}::UUID
      `;

      log.info('Confirmed match: purchase order', { bankTransactionId, candidateId }, 'accounting-api');
    } else {
      // journal_line — use the existing matchTransaction function
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
