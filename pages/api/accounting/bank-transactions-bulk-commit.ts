/**
 * Bulk Bank Statement Import — COMMIT (per-file)
 *
 * POST /api/accounting/bank-transactions-bulk-commit
 *
 * Per-file commit endpoint. The client orchestrates a bulk import by
 * calling this endpoint once per file, passing the same `bulkImportId`
 * (a client-generated UUID) on every call so all the resulting
 * `bank_import_batches` rows share the bulk grouping. We do this
 * per-file rather than one giant batch because a single 250 MB upload
 * would never fit through Next.js's body parser.
 *
 * Behaviour:
 *   - Hard-blocks PDFs whose extracted account number doesn't match
 *     the chosen bank account (403 — same gate as the legacy
 *     single-file flow).
 *   - Dedupes against existing `bank_transactions` in the same date
 *     window before inserting.
 *   - Charges PAYG `bank.import` once per successful file. If the
 *     wallet is short, returns 402 and the file is reported as
 *     failed in the client's summary.
 *   - Returns one result row; the client aggregates across files into
 *     the bulk-import summary card.
 *
 * Body:
 *   {
 *     bankAccountId: string;
 *     bulkImportId: string;          // UUID minted client-side
 *     bulkSequence: number;          // 1-based position in the bulk
 *     filename: string;
 *     fileType: 'pdf' | 'csv' | 'ofx' | 'qif';
 *     statementDate: string;         // YYYY-MM-DD; client derives from preview's dateRange.to
 *     sourceFileSizeBytes: number;
 *     pdfBase64?: string;
 *     csvContent?: string;
 *     bankFormat?: BankFormat;
 *     applyBankRules?: boolean;
 *   }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rateLimit';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';
import {
  deductFlows,
  refundFlows,
  triggerAutoTopup,
  recalculateNudge,
  InsufficientFlowsError,
} from '@/modules/billing/services/flowWalletService';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { importParsedTransactions } from '@/modules/accounting/services/bank/bankImportService';
import { applyRules as applyBankRulesService } from '@/modules/accounting/services/bank/bankRulesService';
import {
  parseStatement,
  type StatementFileType,
} from '@/modules/accounting/services/bank/bankStatementParseService';
import { compareBankAccountNumbers } from '@/modules/accounting/utils/bankAccountNumberMatch';
import {
  bankTransactionHash,
  type HashableTransaction,
} from '@/modules/accounting/utils/bankTransactionHash';
import type { BankCsvParseResult, BankFormat } from '@/modules/accounting/types/bank.types';

export const config = {
  api: { bodyParser: { sizeLimit: '30mb' } },
};

interface BulkCommitRequest {
  bankAccountId?: string;
  bulkImportId?: string;
  bulkSequence?: number;
  filename?: string;
  fileType?: StatementFileType;
  statementDate?: string;
  sourceFileSizeBytes?: number;
  pdfBase64?: string;
  csvContent?: string;
  bankFormat?: BankFormat;
  applyBankRules?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const authReq = req as CompanyAuthedRequest;
  const { companyId } = authReq;
  const body = (req.body ?? {}) as BulkCommitRequest;
  const {
    bankAccountId,
    bulkImportId,
    bulkSequence,
    filename,
    fileType,
    statementDate,
    sourceFileSizeBytes,
    pdfBase64,
    csvContent,
    bankFormat,
    applyBankRules,
  } = body;

  if (!bankAccountId) return apiResponse.badRequest(res, 'bankAccountId is required');
  if (!bulkImportId || !UUID_RE.test(bulkImportId)) {
    return apiResponse.badRequest(res, 'bulkImportId must be a valid UUID');
  }
  if (!Number.isInteger(bulkSequence) || (bulkSequence as number) < 1) {
    return apiResponse.badRequest(res, 'bulkSequence must be a positive integer');
  }
  if (!filename) return apiResponse.badRequest(res, 'filename is required');
  if (!statementDate) return apiResponse.badRequest(res, 'statementDate is required');

  // Pentest M16: cap decoded base64 size before decoding.
  if (pdfBase64 && Buffer.byteLength(pdfBase64, 'base64') > 15 * 1024 * 1024) {
    return apiResponse.badRequest(res, 'PDF file exceeds 15MB limit');
  }
  // Pentest M22: rate-limit the commit to bound DB write pressure.
  if (!(await checkRateLimit(`bank-bulk-commit:${companyId}`, { max: 60, windowSecs: 3600 }))) {
    return apiResponse.tooManyRequests(res);
  }

  // 1. Verify the chosen bank account belongs to this company.
  const accountRows = (await sql`
    SELECT bank_account_number
    FROM gl_accounts
    WHERE id = ${bankAccountId}
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

  // 2. Parse via the shared service.
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
    log.warn('Bulk commit parse failed', { error: msg, filename }, 'accounting-api');
    return apiResponse.badRequest(res, msg);
  }

  if (parseResult.errors.length > 0 && parseResult.transactions.length === 0) {
    return apiResponse.badRequest(res, parseResult.errors[0]!.error);
  }

  // 3. Hard-block on account-number mismatch (PDFs only — CSV/OFX/QIF
  //    have no account number in the file).
  if (resolvedFileType === 'pdf' && parseResult.accountNumber) {
    const match = compareBankAccountNumbers(parseResult.accountNumber, storedAccountNumber);
    if (match === 'mismatch') {
      log.warn('Bulk commit blocked: account number mismatch', {
        bankAccountId, companyId, filename,
        statementAccountNumber: parseResult.accountNumber,
      }, 'accounting-api');
      return apiResponse.forbidden(
        res,
        `${filename} belongs to a different bank account than the one you selected.`,
      );
    }
  }

  // 4. Dedupe against the DB.
  let dedupedTxs = parseResult.transactions;
  let duplicateCount = 0;
  if (parseResult.transactions.length > 0) {
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
        WHERE bank_account_id = ${bankAccountId}
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

  if (dedupedTxs.length === 0) {
    log.info('Bulk commit: all rows duplicates, nothing inserted', {
      bankAccountId, companyId, filename, totalParsed: parseResult.transactions.length,
    }, 'accounting-api');
    return apiResponse.success(res, {
      filename,
      status: 'skipped' as const,
      bulkImportId,
      bulkSequence,
      transactionCount: 0,
      duplicateCount,
      totalParsed: parseResult.transactions.length,
      appliedRules: 0,
      reason: 'all_duplicates',
    });
  }

  // 5. PAYG metering — debit one `bank.import` charge per successful
  //    file. We do this manually instead of via withFlowMeter because
  //    withFlowMeter's cost is fixed at construction time and we
  //    need per-file charges with refund-on-failure semantics.
  const flowCost = getFlowCost('bank.import');
  const plan = await getCompanyPlan(companyId);
  const isPayg = plan?.planCode === 'payg';
  let didDebit = false;

  if (isPayg) {
    try {
      await deductFlows(companyId, flowCost, 'bank.import', bulkImportId);
      didDebit = true;
    } catch (err) {
      if (err instanceof InsufficientFlowsError) {
        const topup = await triggerAutoTopup(companyId);
        if (topup.success) {
          await deductFlows(companyId, flowCost, 'bank.import', bulkImportId);
          didDebit = true;
        } else {
          return apiResponse.paymentRequired(res, {
            balance: err.balance,
            required: err.required,
            operationCode: 'bank.import',
          });
        }
      } else {
        throw err;
      }
    }
  }

  // 6. Insert. On failure, refund the PAYG debit so the user isn't
  //    charged for a no-op.
  try {
    const filteredResult: BankCsvParseResult = {
      ...parseResult,
      transactions: dedupedTxs,
    };

    const result = await importParsedTransactions(
      companyId,
      filteredResult,
      bankAccountId,
      statementDate,
      {
        sourceFilename: filename,
        importedBy: authReq.user?.id,
        bulkContext: {
          bulkImportId,
          bulkSequence: bulkSequence as number,
          sourceFilename: filename,
          sourceFileSizeBytes: Number(sourceFileSizeBytes ?? 0),
        },
      },
    );

    let appliedRuleCount = 0;
    if (applyBankRules === true) {
      try {
        const ruleResult = await applyBankRulesService(
          companyId,
          bankAccountId,
          authReq.user.id,
        );
        appliedRuleCount = ruleResult.applied;
      } catch (err) {
        log.warn('Failed to apply bank rules after bulk commit file', {
          error: err, filename,
        }, 'accounting-api');
      }
    }

    if (isPayg && didDebit) {
      void recalculateNudge(companyId).catch((err: unknown) => {
        log.warn('recalculateNudge failed after bulk commit',
          err instanceof Error ? { message: err.message } : { err },
          'BILLING');
      });
    }

    return apiResponse.success(res, {
      filename,
      status: 'imported' as const,
      bulkImportId,
      bulkSequence,
      batchId: result.batchId,
      transactionCount: result.transactionCount,
      duplicateCount,
      totalParsed: parseResult.transactions.length,
      appliedRules: appliedRuleCount,
    });
  } catch (insertErr) {
    if (isPayg && didDebit) {
      try {
        await refundFlows(companyId, flowCost, 'bank.import', bulkImportId);
      } catch (refundErr) {
        log.error('Bulk commit refund failed after insert error',
          refundErr instanceof Error
            ? { message: refundErr.message, companyId, filename }
            : { refundErr, companyId, filename },
          'BILLING');
      }
    }
    throw insertErr;
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
