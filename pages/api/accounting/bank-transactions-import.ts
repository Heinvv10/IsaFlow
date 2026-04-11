/**
 * Bank Statement Import API
 * POST /api/accounting/bank-transactions-import
 *
 * Commit step of the import flow. The preview is served by
 * /api/accounting/bank-transactions-import-preview and returns the same
 * parsed metadata (detected bank, matched account, dedupe counts, rule
 * match count) without writing anything — the UI should call preview
 * first, show the review panel, then POST here to commit.
 *
 * Body (PDF):
 *   { pdfBase64, bankAccountId, statementDate,
 *     bankFormat?, fileType: 'pdf',
 *     applyBankRules?: boolean }
 *
 * Body (CSV / OFX / QIF):
 *   { csvContent, bankAccountId, statementDate,
 *     bankFormat?, fileType: 'csv' | 'ofx' | 'qif',
 *     applyBankRules?: boolean }
 *
 * Security:
 *   - withWriteAccess (owner/admin/manager default)
 *   - PDF path: compares the extracted account # against the selected
 *     bank account's stored number (same gate as before). Mismatch → 403.
 *   - Duplicate rows (matching content hash already present on the
 *     target account) are silently skipped on insert. Returned counts
 *     tell the UI how many were new vs duplicate.
 *   - Optional applyBankRules=true calls bankRulesService.applyRules
 *     after the insert, which populates suggestion fields on the new
 *     rows (no journal entries are posted).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { importParsedTransactions } from '@/modules/accounting/services/bankReconciliationService';
import { applyRules as applyBankRulesService } from '@/modules/accounting/services/bankRulesService';
import {
  parseStatement,
  type StatementFileType,
} from '@/modules/accounting/services/bankStatementParseService';
import { compareBankAccountNumbers } from '@/modules/accounting/utils/bankAccountNumberMatch';
import {
  bankTransactionHash,
  type HashableTransaction,
} from '@/modules/accounting/utils/bankTransactionHash';
import type { BankCsvParseResult, BankFormat } from '@/modules/accounting/types/bank.types';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const authReq = req as CompanyApiRequest;
  const { companyId } = authReq;

  const {
    csvContent,
    pdfBase64,
    fileType,
    bankAccountId,
    statementDate,
    bankFormat,
    applyBankRules,
  } = req.body as {
    csvContent?: string;
    pdfBase64?: string;
    fileType?: StatementFileType;
    bankAccountId: string;
    statementDate: string;
    bankFormat?: BankFormat;
    applyBankRules?: boolean;
  };

  if (!bankAccountId || !statementDate) {
    return apiResponse.badRequest(res, 'bankAccountId and statementDate are required');
  }

  // 1. Verify the selected bank account belongs to this company and
  //    fetch its stored account number for the PDF security gate.
  const accountRows = (await sql`
    SELECT bank_account_number
    FROM gl_accounts
    WHERE id = ${String(bankAccountId)}
      AND company_id = ${companyId}
      AND account_subtype = 'bank'
      AND is_active = true
    LIMIT 1
  `) as Array<{ bank_account_number: string | null }>;
  if (accountRows.length === 0) {
    return apiResponse.badRequest(res, 'Selected bank account not found for this company');
  }
  const storedAccountNumber = accountRows[0]?.bank_account_number ?? null;

  const resolvedFileType: StatementFileType = fileType ?? (pdfBase64 ? 'pdf' : 'csv');

  // 2. Parse via the shared service (same code path as preview).
  let parseResult: BankCsvParseResult;
  try {
    parseResult = await parseStatement({
      fileType: resolvedFileType,
      pdfBase64,
      csvContent,
      bankFormat,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to parse statement';
    log.warn('Bank import parse failed', { error: msg, fileType: resolvedFileType }, 'accounting-api');
    return apiResponse.badRequest(res, msg);
  }

  if (parseResult.errors.length > 0 && parseResult.transactions.length === 0) {
    return apiResponse.badRequest(res, parseResult.errors[0]!.error);
  }

  // 3. Security gate on PDFs: if the parser extracted an account number
  //    from the statement header, it MUST match the selected bank
  //    account's stored number.
  if (resolvedFileType === 'pdf' && parseResult.accountNumber) {
    const match = compareBankAccountNumbers(parseResult.accountNumber, storedAccountNumber);
    if (match === 'mismatch') {
      log.warn('Bank statement import blocked: account number mismatch', {
        bankAccountId, companyId,
        statementAccountNumber: parseResult.accountNumber,
        // Don't log the stored number — customer secret.
      }, 'accounting-api');
      return apiResponse.forbidden(
        res,
        'This statement belongs to a different bank account than the one you selected. ' +
          'Please choose the correct account or upload the matching statement.',
      );
    }
  }

  // 4. Duplicate detection. Pre-load existing bank_transactions in the
  //    statement's date range and skip any parsed row whose content
  //    hash already exists. This is what stops double-imports.
  let dedupedTxs = parseResult.transactions;
  let duplicateCount = 0;

  if (parseResult.transactions.length > 0) {
    // Compute the date window from the parsed file itself.
    const dates = parseResult.transactions
      .map(t => t.transactionDate)
      .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d))
      .sort();
    const from = dates[0];
    const to = dates[dates.length - 1];

    if (from && to) {
      const existing = (await sql`
        SELECT transaction_date::text AS transaction_date, amount, description
        FROM bank_transactions
        WHERE bank_account_id = ${String(bankAccountId)}
          AND transaction_date BETWEEN ${from} AND ${to}
      `) as Array<{ transaction_date: string; amount: string | number; description: string | null }>;

      const existingHashes = new Set<string>();
      for (const row of existing) {
        const hashable: HashableTransaction = {
          transactionDate: row.transaction_date,
          amount: Number(row.amount),
          description: row.description ?? '',
        };
        existingHashes.add(bankTransactionHash(hashable));
      }

      dedupedTxs = parseResult.transactions.filter(tx => {
        // Hash without balance to match existingHashes above — existing
        // rows don't persist balance, so including it here would break
        // dedupe for any parser that emits per-row balances (e.g. the
        // ABSA running-balance parser).
        const h = bankTransactionHash({
          transactionDate: tx.transactionDate,
          amount: tx.amount,
          description: tx.description ?? '',
        });
        if (existingHashes.has(h)) {
          duplicateCount++;
          return false;
        }
        return true;
      });
    }
  }

  // 5. Insert the non-duplicate rows. Short-circuit if nothing to insert.
  if (dedupedTxs.length === 0) {
    log.info('Bank import: all rows are duplicates, nothing inserted', {
      bankAccountId, companyId, totalParsed: parseResult.transactions.length,
    }, 'accounting-api');
    return apiResponse.created(res, {
      batchId: '',
      transactionCount: 0,
      duplicateCount,
      totalParsed: parseResult.transactions.length,
      appliedRules: 0,
      errors: parseResult.errors,
    });
  }

  const filteredResult: BankCsvParseResult = {
    ...parseResult,
    transactions: dedupedTxs,
  };

  const result = await importParsedTransactions(
    companyId,
    filteredResult,
    String(bankAccountId),
    String(statementDate),
  );

  // 6. Optionally apply bank rules to the newly-inserted transactions.
  //    The service mutates suggested_* fields in place — no journal
  //    entries are posted.
  let appliedRuleCount = 0;
  if (applyBankRules === true) {
    try {
      const ruleResult = await applyBankRulesService(
        companyId,
        String(bankAccountId),
        authReq.user.id,
      );
      appliedRuleCount = ruleResult.applied;
      log.info('Bank rules applied after import', {
        bankAccountId, applied: appliedRuleCount,
      }, 'accounting-api');
    } catch (err) {
      log.warn('Failed to apply bank rules after import', { error: err }, 'accounting-api');
    }
  }

  return apiResponse.created(res, {
    batchId: result.batchId,
    transactionCount: result.transactionCount,
    duplicateCount,
    totalParsed: parseResult.transactions.length,
    appliedRules: appliedRuleCount,
    errors: result.errors,
  });
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
