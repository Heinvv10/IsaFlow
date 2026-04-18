/**
 * Bank Statement Import PREVIEW API
 *
 * POST /api/accounting/bank-transactions-import-preview
 *
 * Parses an uploaded bank statement WITHOUT committing anything to the DB
 * and returns a preview so the UI can build a "review before import"
 * screen:
 *
 *   - detectedBank           — bank format identified from the file
 *   - extractedAccountNumber — account number parsed from the statement header
 *                              (PDFs only; CSVs don't include one)
 *   - matchedBankAccountId   — existing gl_accounts row whose bank_account_number
 *                              matches the extracted number (scoped to company)
 *   - matchedBankAccountName — human-readable name for the review UI
 *   - dateRange              — first/last transaction date
 *   - totalParsed            — total rows parsed from the file
 *   - newCount               — rows that are NOT already in the DB
 *   - duplicateCount         — rows with a matching content hash already in DB
 *   - sampleTransactions     — first 10 rows for preview rendering
 *   - ruleMatchCount         — how many rows would be auto-categorised by
 *                              existing bank rules (informational only —
 *                              nothing is applied until commit)
 *   - warnings               — UX hints ("No matching bank account found —
 *                              create one to continue", etc.)
 *
 * Body (PDF):
 *   { pdfBase64, bankFormat?, fileType: 'pdf' }
 *
 * Body (CSV / OFX / QIF):
 *   { csvContent, bankFormat?, fileType: 'csv' | 'ofx' | 'qif',
 *     bankAccountId?  // required for CSVs since they have no account # in-file
 *   }
 *
 * No bank account is created or modified — this endpoint is a pure read.
 * But we still require write-role access because the UX flow it feeds
 * into leads directly to a destructive insert.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
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
import type {
  BankCsvParseResult,
  BankFormat,
  ParsedBankTransaction,
} from '@/modules/accounting/types/bank.types';

// ── Rule matching (in-memory, mirrors bankRulesService SQL semantics) ────────

interface RuleRow {
  id: string;
  match_field: 'description' | 'reference' | 'both';
  match_type: 'contains' | 'starts_with' | 'ends_with' | 'exact';
  match_pattern: string;
  is_active: boolean;
}

function ruleMatchesTransaction(rule: RuleRow, tx: ParsedBankTransaction): boolean {
  const pattern = rule.match_pattern.toLowerCase();
  const fields: string[] = [];
  if (rule.match_field === 'description' || rule.match_field === 'both') {
    fields.push((tx.description ?? '').toLowerCase());
  }
  if (rule.match_field === 'reference' || rule.match_field === 'both') {
    fields.push((tx.reference ?? '').toLowerCase());
  }
  return fields.some(f => {
    switch (rule.match_type) {
      case 'contains':    return f.includes(pattern);
      case 'starts_with': return f.startsWith(pattern);
      case 'ends_with':   return f.endsWith(pattern);
      case 'exact':       return f === pattern;
      default:            return false;
    }
  });
}

// ── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const {
    pdfBase64,
    csvContent,
    fileType,
    bankFormat,
    bankAccountId: userSelectedAccountId,
  } = req.body as {
    pdfBase64?: string;
    csvContent?: string;
    fileType?: 'pdf' | 'csv' | 'ofx' | 'qif';
    bankFormat?: BankFormat;
    bankAccountId?: string;
  };

  const resolvedFileType: StatementFileType = fileType ?? (pdfBase64 ? 'pdf' : 'csv');

  // 1. Parse the file.
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
    return apiResponse.badRequest(res, msg);
  }

  if (parseResult.errors.length > 0 && parseResult.transactions.length === 0) {
    return apiResponse.badRequest(res, parseResult.errors[0]!.error);
  }

  // 2. Auto-match account by extracted account number.
  //    Strict rule: imports MUST go into an existing bank account whose
  //    stored number matches the one on the statement. No manual override.
  const warnings: string[] = [];
  let matchedBankAccountId: string | null = null;
  let matchedBankAccountName: string | null = null;
  let matchedBankAccountNumber: string | null = null;

  if (parseResult.accountNumber) {
    const rows = (await sql`
      SELECT id, account_name, bank_account_number
      FROM gl_accounts
      WHERE company_id = ${companyId}
        AND account_subtype = 'bank'
        AND is_active = true
    `) as Array<{ id: string; account_name: string; bank_account_number: string | null }>;

    for (const row of rows) {
      const cmp = compareBankAccountNumbers(parseResult.accountNumber, row.bank_account_number);
      if (cmp === 'match') {
        matchedBankAccountId = row.id;
        matchedBankAccountName = row.account_name;
        matchedBankAccountNumber = row.bank_account_number;
        break;
      }
    }

    if (!matchedBankAccountId) {
      warnings.push(
        `No bank account in this company matches the statement's account ` +
          `number ${parseResult.accountNumber}. Create a matching bank ` +
          `account before importing.`,
      );
    }
  } else if (resolvedFileType === 'csv' || resolvedFileType === 'ofx' || resolvedFileType === 'qif') {
    // CSV/OFX/QIF don't include account numbers in the header — fall back
    // to the bankAccountId the user picked manually in the UI if one was
    // provided. If none was provided, the caller gets a "please pick an
    // account" warning and the UI prompts for one.
    if (userSelectedAccountId) {
      const rows = (await sql`
        SELECT id, account_name, bank_account_number
        FROM gl_accounts
        WHERE id = ${userSelectedAccountId}
          AND company_id = ${companyId}
          AND account_subtype = 'bank'
          AND is_active = true
        LIMIT 1
      `) as Array<{ id: string; account_name: string; bank_account_number: string | null }>;
      if (rows.length > 0) {
        matchedBankAccountId = rows[0]!.id;
        matchedBankAccountName = rows[0]!.account_name;
        matchedBankAccountNumber = rows[0]!.bank_account_number;
      } else {
        warnings.push('The selected bank account could not be found.');
      }
    } else {
      warnings.push(
        'This file format does not include the account number. Please ' +
          'select which bank account this statement belongs to.',
      );
    }
  } else {
    warnings.push(
      'Could not extract the account number from this statement. ' +
        'You may need to pick the bank account manually.',
    );
  }

  // 3. Date range.
  const dates = parseResult.transactions
    .map(t => t.transactionDate)
    .filter(d => /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  const dateRange = dates.length > 0
    ? { from: dates[0]!, to: dates[dates.length - 1]! }
    : null;

  // 4. Duplicate detection — only possible once we have a target account.
  let newCount = parseResult.transactions.length;
  let duplicateCount = 0;
  if (matchedBankAccountId && dateRange) {
    const existing = (await sql`
      SELECT transaction_date::text AS transaction_date, amount, description
      FROM bank_transactions
      WHERE bank_account_id = ${matchedBankAccountId}
        AND transaction_date BETWEEN ${dateRange.from} AND ${dateRange.to}
    `) as Array<{ transaction_date: string; amount: string | number; description: string | null }>;

    const existingHashes = new Set<string>();
    for (const row of existing) {
      const hashable: HashableTransaction = {
        transactionDate: row.transaction_date,
        amount: Number(row.amount),
        description: row.description ?? '',
        // Existing rows don't persist balance yet, so we hash without it.
        // Preview de-dupe is a heuristic — the commit endpoint will also
        // run the same check so a mis-count here is non-destructive.
      };
      existingHashes.add(bankTransactionHash(hashable));
    }

    for (const tx of parseResult.transactions) {
      // Hash without balance to match existingHashes above — existing
      // bank_transactions rows don't persist a balance column, so the
      // parsed-row hash must exclude it or every re-import would look new.
      const dedupeHash = bankTransactionHash({
        transactionDate: tx.transactionDate,
        amount: tx.amount,
        description: tx.description ?? '',
      });
      if (existingHashes.has(dedupeHash)) duplicateCount++;
    }
    newCount = parseResult.transactions.length - duplicateCount;
  }

  // 5. Rule match count — purely informational for the preview.
  let ruleMatchCount = 0;
  try {
    const rules = (await sql`
      SELECT id, match_field, match_type, match_pattern, is_active
      FROM bank_categorisation_rules
      WHERE company_id = ${companyId}::UUID AND is_active = true
      ORDER BY priority ASC
    `) as RuleRow[];
    for (const tx of parseResult.transactions) {
      if (rules.some(r => ruleMatchesTransaction(r, tx))) ruleMatchCount++;
    }
  } catch (err) {
    log.warn('Failed to load bank rules for preview count', { error: err }, 'accounting-api');
  }

  // 6. Sample rows for the preview panel.
  const sampleTransactions = parseResult.transactions.slice(0, 10).map(tx => ({
    date: tx.transactionDate,
    amount: tx.amount,
    description: tx.description,
    balance: tx.balance,
  }));

  return apiResponse.success(res, {
    detectedBank: parseResult.bankFormat,
    extractedAccountNumber: parseResult.accountNumber ?? null,
    matchedBankAccountId,
    matchedBankAccountName,
    matchedBankAccountNumberMasked:
      matchedBankAccountNumber ? `****${matchedBankAccountNumber.slice(-4)}` : null,
    dateRange,
    totalParsed: parseResult.transactions.length,
    newCount,
    duplicateCount,
    ruleMatchCount,
    sampleTransactions,
    warnings,
  });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
