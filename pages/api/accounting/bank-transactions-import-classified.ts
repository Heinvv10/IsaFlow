/**
 * Classified Bank Transactions Import API
 * POST /api/accounting/bank-transactions-import-classified
 *   Import pre-classified bank transactions from worksheets.
 *
 * Body: { bankAccountId, transactions: ClassifiedBankTx[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

interface ClassifiedBankTx {
  transactionDate: string;
  description: string;
  debit?: number;
  credit?: number;
  category?: string;
  costCentreT1?: string;
  costCentreT2?: string;
  businessUnit?: string;
  statementRef?: string;
  source?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const { bankAccountId, transactions } = req.body as {
      bankAccountId: string;
      transactions: ClassifiedBankTx[];
    };

    if (!bankAccountId) {
      return apiResponse.badRequest(res, 'bankAccountId is required');
    }
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return apiResponse.badRequest(res, 'transactions array is required');
    }

    // Verify bank account exists
    const bankCheck = (await sql`
      SELECT id FROM gl_accounts WHERE id = ${bankAccountId}::UUID AND company_id = ${companyId} LIMIT 1
    `) as Row[];
    if (bankCheck.length === 0) {
      return apiResponse.notFound(res, 'Bank account', bankAccountId);
    }

    // Pre-load category → GL account mapping from existing rules
    const ruleRows = (await sql`
      SELECT LOWER(rule_name) AS rule_name, gl_account_id, supplier_id
      FROM bank_categorisation_rules
      WHERE is_active = true AND company_id = ${companyId}
    `) as Row[];
    const categoryMap = new Map<string, { glAccountId: string; supplierId: number | null }>();
    for (const r of ruleRows) {
      categoryMap.set(String(r.rule_name).toLowerCase(), {
        glAccountId: String(r.gl_account_id),
        supplierId: r.supplier_id ? Number(r.supplier_id) : null,
      });
    }

    const batchId = crypto.randomUUID();
    let inserted = 0;
    let skippedDuplicates = 0;
    const unresolvedCategories: string[] = [];

    for (const tx of transactions) {
      const debit = Number(tx.debit || 0);
      const credit = Number(tx.credit || 0);
      // positive = deposit (credit), negative = withdrawal (debit)
      const amount = credit > 0 ? credit : -debit;
      if (amount === 0) continue;

      const txDate = String(tx.transactionDate).trim();
      const desc = String(tx.description || '').trim();
      if (!txDate || !desc) continue;

      // Deduplicate: check for existing transaction with same date + amount + description
      const dupeCheck = (await sql`
        SELECT id FROM bank_transactions
        WHERE bank_account_id = ${bankAccountId}::UUID
          AND transaction_date = ${txDate}
          AND amount = ${amount}
          AND description = ${desc}
          AND company_id = ${companyId}
        LIMIT 1
      `) as Row[];

      if (dupeCheck.length > 0) {
        skippedDuplicates++;
        continue;
      }

      // Resolve category → GL account
      const category = String(tx.category || '').trim();
      const categoryLower = category.toLowerCase();
      const mapping = categoryMap.get(categoryLower);
      const suggestedGlAccountId = mapping?.glAccountId || null;
      const suggestedSupplierId = mapping?.supplierId || null;

      if (category && !mapping && !unresolvedCategories.includes(category)) {
        unresolvedCategories.push(category);
      }

      const costCentre = [tx.costCentreT1, tx.costCentreT2]
        .filter(Boolean)
        .join(' > ')
        .trim() || null;

      await sql`
        INSERT INTO bank_transactions (
          bank_account_id, transaction_date, amount, description,
          reference, import_batch_id, status,
          suggested_gl_account_id, suggested_supplier_id,
          suggested_category, suggested_cost_centre,
          company_id
        ) VALUES (
          ${bankAccountId}::UUID, ${txDate}, ${amount}, ${desc},
          ${tx.statementRef || null}, ${batchId}::UUID, 'imported',
          ${suggestedGlAccountId}::UUID, ${suggestedSupplierId},
          ${category || null}, ${costCentre},
          ${companyId}
        )
      `;
      inserted++;
    }

    log.info('Imported classified bank transactions', {
      batchId, bankAccountId, inserted, skippedDuplicates,
      unresolvedCategories: unresolvedCategories.length,
    }, 'accounting');

    return apiResponse.created(res, {
      batchId,
      inserted,
      skippedDuplicates,
      unresolvedCategories: unresolvedCategories.length > 0 ? unresolvedCategories : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to import classified transactions';
    log.error('Failed to import classified bank transactions', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
