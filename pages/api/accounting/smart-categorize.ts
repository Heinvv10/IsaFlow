/**
 * Smart Categorization API
 * GET  — get suggestions for a single transaction
 * POST — bulk categorize transactions or learn from allocation
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  categorizeBankTransaction,
  bulkCategorize,
  smartCategorizeForAccount,
  learnFromAllocation,
} from '@/modules/accounting/services/smartCategorizationService';
import { sql } from '@/lib/neon';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  // ── GET: Single transaction suggestion ─────────────────────────────────────
  if (req.method === 'GET') {
    const { txId } = req.query;
    if (!txId || typeof txId !== 'string') {
      return apiResponse.badRequest(res, 'txId query parameter required');
    }

    try {
      const txRows = (await sql`
        SELECT id, description, amount, reference
        FROM bank_transactions WHERE id = ${txId}::UUID AND company_id = ${companyId}
      `) as Row[];

      if (txRows.length === 0) {
        return apiResponse.notFound(res, 'Transaction', txId);
      }

      const tx = txRows[0];
      const result = await categorizeBankTransaction(companyId, {
        description: String(tx.description || ''),
        amount: Number(tx.amount),
        reference: tx.reference ? String(tx.reference) : undefined,
      });

      return apiResponse.success(res, {
        transactionId: txId,
        suggestion: result,
      });
    } catch (err) {
      log.error('Smart categorize GET failed', { txId, error: err }, 'accounting-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed');
    }
  }

  // ── POST: Bulk categorize or learn ─────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, transactionIds, bankAccountId, txId, glAccountId, category, vatCode } = req.body;

    try {
      switch (action || 'categorize') {
        case 'categorize': {
          // If bankAccountId provided, categorize all uncategorized for that account
          if (bankAccountId) {
            const result = await smartCategorizeForAccount(companyId, bankAccountId);
            return apiResponse.success(res, result);
          }
          // Otherwise, categorize specific transaction IDs
          if (!Array.isArray(transactionIds) || transactionIds.length === 0) {
            return apiResponse.badRequest(res, 'transactionIds array or bankAccountId required');
          }
          const result = await bulkCategorize(companyId, transactionIds);
          return apiResponse.success(res, result);
        }

        case 'learn': {
          if (!txId || !glAccountId || !category) {
            return apiResponse.badRequest(res, 'txId, glAccountId, and category required');
          }
          await learnFromAllocation(companyId, txId, glAccountId, category, vatCode);
          return apiResponse.success(res, { learned: true });
        }

        default:
          return apiResponse.badRequest(res, `Unknown action: ${action}`);
      }
    } catch (err) {
      log.error('Smart categorize POST failed', { action, error: err }, 'accounting-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Action failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
