/**
 * Bank Transaction Actions API
 * POST /api/accounting/bank-transactions-action
 *   action: match | unmatch | exclude | auto_match | allocate | delete | update_notes
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import {
  matchTransaction,
  unmatchTransaction,
  excludeTransaction,
  autoMatchTransactions,
  allocateTransaction,
  splitAllocateTransaction,
  deleteTransactions,
  bulkAcceptTransactions,
  reverseReconciledTransaction,
  type AllocationType,
  type SplitLine,
} from '@/modules/accounting/services/bankReconciliationService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req;

  try {
    const { action, bankTransactionId, journalLineId, bankAccountId, reconciliationId, contraAccountId, description, allocationType, entityId, vatCode, excludeReason, cc1Id, cc2Id, buId } = req.body;
    const userId: string = req.user?.id || req.user?.userId || 'system';

    if (!action) return apiResponse.badRequest(res, 'action is required');

    switch (action) {
      case 'match': {
        if (!bankTransactionId || !journalLineId) {
          return apiResponse.badRequest(res, 'bankTransactionId and journalLineId are required');
        }
        const tx = await matchTransaction(companyId, bankTransactionId, journalLineId, reconciliationId);
        return apiResponse.success(res, tx);
      }
      case 'unmatch': {
        if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId is required');
        const tx = await unmatchTransaction(companyId, bankTransactionId);
        return apiResponse.success(res, tx);
      }
      case 'exclude': {
        if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId is required');
        const tx = await excludeTransaction(
          companyId, bankTransactionId,
          typeof excludeReason === 'string' ? excludeReason : undefined,
        );
        return apiResponse.success(res, tx);
      }
      case 'auto_match': {
        if (!bankAccountId) return apiResponse.badRequest(res, 'bankAccountId is required');
        const result = await autoMatchTransactions(companyId, bankAccountId, reconciliationId);
        return apiResponse.success(res, result);
      }
      case 'allocate': {
        const aType: AllocationType = allocationType || 'account';
        if (aType === 'account' && !contraAccountId) {
          return apiResponse.badRequest(res, 'contraAccountId is required for account allocation');
        }
        if ((aType === 'supplier' || aType === 'customer') && !entityId) {
          return apiResponse.badRequest(res, 'entityId is required for supplier/customer allocation');
        }
        if (!bankTransactionId) {
          return apiResponse.badRequest(res, 'bankTransactionId is required');
        }
        const result = await allocateTransaction(
          companyId, bankTransactionId, contraAccountId || '', userId, description, aType, entityId, vatCode,
          cc1Id, cc2Id, buId,
        );
        return apiResponse.success(res, result);
      }
      case 'split_allocate': {
        const { bankTransactionId: splitTxId, lines: splitLines } = req.body as {
          bankTransactionId?: string;
          lines?: SplitLine[];
        };
        if (!splitTxId || !splitLines || !Array.isArray(splitLines) || splitLines.length === 0) {
          return apiResponse.badRequest(res, 'bankTransactionId and lines[] (non-empty) are required');
        }
        const splitResult = await splitAllocateTransaction(companyId, splitTxId, splitLines, userId);
        return apiResponse.success(res, splitResult);
      }
      case 'delete': {
        const { bankTransactionIds } = req.body;
        const ids: string[] = bankTransactionIds || (bankTransactionId ? [bankTransactionId] : []);
        if (ids.length === 0) return apiResponse.badRequest(res, 'bankTransactionId or bankTransactionIds required');
        const deleted = await deleteTransactions(companyId, ids);
        return apiResponse.success(res, { deleted });
      }
      case 'bulk_accept': {
        const { bankTransactionIds: bulkIds } = req.body;
        const ids: string[] = Array.isArray(bulkIds) ? bulkIds : [];
        if (ids.length === 0) return apiResponse.badRequest(res, 'bankTransactionIds (array) required');
        const accepted = await bulkAcceptTransactions(companyId, ids);
        return apiResponse.success(res, { accepted });
      }
      case 'update_notes': {
        if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId required');
        const { notes } = req.body as { notes?: string };
        await sql`
          UPDATE bank_transactions
          SET notes = ${notes || null}, updated_at = NOW()
          WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
        `;
        log.info('Updated bank transaction notes', { bankTransactionId }, 'accounting-api');
        return apiResponse.success(res, { updated: true });
      }
      case 'save_selection': {
        if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId required');
        const selType: string = req.body.selectionType || 'account';
        const selEntityId: string | null = req.body.selectionEntityId || null;
        const selVatCode: string | null = req.body.vatCode || null;
        await sql`
          UPDATE bank_transactions
          SET suggested_gl_account_id = ${selType === 'account' && selEntityId ? selEntityId : null}::UUID,
              suggested_supplier_id = ${selType === 'supplier' && selEntityId ? selEntityId : null}::UUID,
              suggested_client_id = ${selType === 'customer' && selEntityId ? selEntityId : null}::UUID,
              suggested_vat_code = ${selVatCode},
              updated_at = NOW()
          WHERE id = ${bankTransactionId}::UUID AND status IN ('imported', 'allocated') AND company_id = ${companyId}
        `;
        return apiResponse.success(res, { saved: true });
      }
      case 'save_dimensions': {
        if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId required');
        await sql`
          UPDATE bank_transactions
          SET cc1_id = ${cc1Id || null}::UUID,
              cc2_id = ${cc2Id || null}::UUID,
              bu_id = ${buId || null}::UUID,
              updated_at = NOW()
          WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}
        `;
        return apiResponse.success(res, { saved: true });
      }
      case 'reverse': {
        if (!bankTransactionId) return apiResponse.badRequest(res, 'bankTransactionId required');
        await reverseReconciledTransaction(companyId, bankTransactionId, userId);
        return apiResponse.success(res, { reversed: true });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Bank transaction action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
