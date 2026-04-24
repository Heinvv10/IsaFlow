/**
 * Bulk Bank Statement Import — PREVIEW
 *
 * POST /api/accounting/bank-transactions-bulk-preview
 *
 * Per-file preview endpoint for the bulk uploader. Called once per file
 * (the client fans out N requests with concurrency capped at 3) so that
 * each file's preview shows up live in the queue table without holding
 * the request open for the whole bulk.
 *
 * Differs from the legacy single-file preview in two ways:
 *   1. `bankAccountId` is REQUIRED — the user picks the target account
 *      up-front, and we use it to classify every file as match /
 *      mismatch / inconclusive / parse_error.
 *   2. Returns `rowHashes` so the client can detect duplicates BETWEEN
 *      uploaded files (overlapping months) without doing a second DB
 *      round-trip.
 *
 * Body:
 *   {
 *     bankAccountId: string;
 *     fileType: 'pdf' | 'csv' | 'ofx' | 'qif';
 *     filename: string;
 *     pdfBase64?: string;            // PDF
 *     csvContent?: string;           // CSV / OFX / QIF
 *     bankFormat?: BankFormat;
 *   }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rateLimit';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  parseStatement,
  type StatementFileType,
} from '@/modules/accounting/services/bank/bankStatementParseService';
import {
  bankTransactionHash,
  type HashableTransaction,
} from '@/modules/accounting/utils/bankTransactionHash';
import { compareBankAccountNumbers } from '@/modules/accounting/utils/bankAccountNumberMatch';
import type { BankCsvParseResult, BankFormat } from '@/modules/accounting/types/bank.types';

export const config = {
  api: { bodyParser: { sizeLimit: '30mb' } },
};

export type AccountMatchStatus = 'match' | 'mismatch' | 'inconclusive' | 'parse_error';

interface BulkPreviewRequest {
  bankAccountId?: string;
  fileType?: StatementFileType;
  filename?: string;
  pdfBase64?: string;
  csvContent?: string;
  bankFormat?: BankFormat;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const body = (req.body ?? {}) as BulkPreviewRequest;
  const {
    bankAccountId,
    fileType,
    filename,
    pdfBase64,
    csvContent,
    bankFormat,
  } = body;

  if (!bankAccountId) {
    return apiResponse.badRequest(res, 'bankAccountId is required for bulk preview');
  }
  if (!filename) {
    return apiResponse.badRequest(res, 'filename is required for bulk preview');
  }

  // Pentest M16: cap decoded base64 size before decoding. 30 MB body allows
  // ~22 MB decoded, buffered entirely in RAM by parseStatement. Bound the
  // decoded size to 15 MB so a single request can't pin a worker.
  if (pdfBase64 && Buffer.byteLength(pdfBase64, 'base64') > 15 * 1024 * 1024) {
    return apiResponse.badRequest(res, 'PDF file exceeds 15MB limit');
  }
  // Pentest M22: rate-limit the expensive per-file preview flow.
  if (!(await checkRateLimit(`bank-bulk-preview:${companyId}`, { max: 60, windowSecs: 3600 }))) {
    return apiResponse.tooManyRequests(res);
  }

  const resolvedFileType: StatementFileType = fileType ?? (pdfBase64 ? 'pdf' : 'csv');

  // 1. Verify the chosen bank account exists in this company and grab
  //    its stored account number for the per-file match check.
  const accountRows = (await sql`
    SELECT id, account_name, bank_account_number
    FROM gl_accounts
    WHERE id = ${bankAccountId}
      AND company_id = ${companyId}
      AND account_subtype = 'bank'
      AND is_active = true
    LIMIT 1
  `) as Array<{ id: string; account_name: string; bank_account_number: string | null }>;
  if (accountRows.length === 0) {
    return apiResponse.badRequest(res, 'Selected bank account not found for this company');
  }
  const storedAccountNumber = accountRows[0]!.bank_account_number;
  const accountName = accountRows[0]!.account_name;

  // 2. Parse the file. Parser failures are returned as a parse_error
  //    row rather than a 4xx so the UI can render the row with an
  //    error pill alongside successful files.
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
    log.warn('Bulk preview parse failed', { error: msg, filename }, 'accounting-api');
    return apiResponse.success(res, {
      filename,
      detectedBank: null,
      extractedAccountNumber: null,
      accountMatch: 'parse_error' as AccountMatchStatus,
      mismatchReason: msg,
      dateRange: null,
      totalParsed: 0,
      duplicatesVsDb: 0,
      rowHashes: [],
      sampleTransactions: [],
      warnings: [msg],
    });
  }

  if (parseResult.errors.length > 0 && parseResult.transactions.length === 0) {
    return apiResponse.success(res, {
      filename,
      detectedBank: parseResult.bankFormat,
      extractedAccountNumber: parseResult.accountNumber ?? null,
      accountMatch: 'parse_error' as AccountMatchStatus,
      mismatchReason: parseResult.errors[0]!.error,
      dateRange: null,
      totalParsed: 0,
      duplicatesVsDb: 0,
      rowHashes: [],
      sampleTransactions: [],
      warnings: parseResult.errors.map(e => e.error),
    });
  }

  // 3. Per-file account match. PDFs that include an account number
  //    must match the chosen account. CSV/OFX/QIF have no account
  //    number in the file itself — they're "inconclusive" and the
  //    UI auto-promotes them since the user already picked the
  //    target account.
  let accountMatch: AccountMatchStatus;
  let mismatchReason: string | undefined;
  if (parseResult.accountNumber) {
    const cmp = compareBankAccountNumbers(parseResult.accountNumber, storedAccountNumber);
    if (cmp === 'match') {
      accountMatch = 'match';
    } else if (cmp === 'mismatch') {
      accountMatch = 'mismatch';
      mismatchReason = `Statement is for account ending ${parseResult.accountNumber.slice(-4)}, ` +
        `but you selected ${accountName}.`;
    } else {
      // 'inconclusive' from the comparator means we couldn't tell —
      // surface as inconclusive so the UI can prompt confirmation.
      accountMatch = 'inconclusive';
    }
  } else {
    accountMatch = 'inconclusive';
  }

  // 4. Date range from the parsed rows.
  const dates = parseResult.transactions
    .map(t => t.transactionDate)
    .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  const dateRange = dates.length > 0
    ? { from: dates[0]!, to: dates[dates.length - 1]! }
    : null;

  // 5. DB dedupe count (same logic as the single-file preview).
  let duplicatesVsDb = 0;
  if (accountMatch !== 'mismatch' && dateRange) {
    const existing = (await sql`
      SELECT transaction_date::text AS transaction_date, amount, description
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}
        AND transaction_date BETWEEN ${dateRange.from} AND ${dateRange.to}
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
    for (const tx of parseResult.transactions) {
      const h = bankTransactionHash({
        transactionDate: tx.transactionDate,
        amount: tx.amount,
        description: tx.description ?? '',
      });
      if (existingHashes.has(h)) duplicatesVsDb++;
    }
  }

  // 6. Row hashes for client-side cross-file dedup.
  const rowHashes = parseResult.transactions.map(tx =>
    bankTransactionHash({
      transactionDate: tx.transactionDate,
      amount: tx.amount,
      description: tx.description ?? '',
    }),
  );

  // 7. Sample for the preview row.
  const sampleTransactions = parseResult.transactions.slice(0, 5).map(tx => ({
    date: tx.transactionDate,
    amount: tx.amount,
    description: tx.description,
  }));

  return apiResponse.success(res, {
    filename,
    detectedBank: parseResult.bankFormat,
    extractedAccountNumber: parseResult.accountNumber ?? null,
    accountMatch,
    mismatchReason,
    dateRange,
    totalParsed: parseResult.transactions.length,
    duplicatesVsDb,
    rowHashes,
    sampleTransactions,
    warnings: parseResult.errors.map(e => e.error),
  });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
