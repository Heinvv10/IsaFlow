/**
 * Bank Reconciliation Report Data API
 * GET /api/accounting/bank-reconciliation-report?bankAccountId=<uuid>
 *
 * Returns matched and unmatched transaction data alongside statement balances
 * for rendering the PDF reconciliation report on the client.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

// ─── Row types returned from DB ───────────────────────────────────────────────

type TxRow = {
  id: string;
  transaction_date: string | Date;
  description: string | null;
  reference: string | null;
  amount: string | number;
  journal_entry_number: string | null;
};

type BatchRow = {
  opening_balance: string | null;
  closing_balance: string | null;
  statement_date: string | Date;
};

type AccountRow = {
  account_name: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDateStr(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().split('T')[0] ?? '';
  return String(d).split('T')[0] ?? '';
}

async function fetchBankAccountName(companyId: string, bankAccountId: string): Promise<string> {
  const rows = (await sql`
    SELECT account_name
    FROM gl_accounts
    WHERE id = ${bankAccountId}::UUID AND company_id = ${companyId}
    LIMIT 1
  `) as AccountRow[];
  return rows[0]?.account_name ?? 'Unknown Account';
}

async function fetchLatestBatch(companyId: string, bankAccountId: string): Promise<BatchRow | null> {
  const rows = (await sql`
    SELECT opening_balance, closing_balance, statement_date
    FROM bank_import_batches
    WHERE bank_account_id = ${bankAccountId}::UUID
    ORDER BY created_at DESC
    LIMIT 1
  `) as BatchRow[];
  return rows[0] ?? null;
}

async function fetchMatchedTransactions(companyId: string, bankAccountId: string): Promise<TxRow[]> {
  return (await sql`
    SELECT
      bt.id,
      bt.transaction_date,
      bt.description,
      bt.reference,
      bt.amount,
      je.entry_number AS journal_entry_number
    FROM bank_transactions bt
    LEFT JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.status = 'matched'
      AND bt.company_id = ${companyId}
    ORDER BY bt.transaction_date
  `) as TxRow[];
}

async function fetchUnmatchedTransactions(companyId: string, bankAccountId: string): Promise<TxRow[]> {
  return (await sql`
    SELECT
      bt.id,
      bt.transaction_date,
      bt.description,
      bt.reference,
      bt.amount,
      NULL::TEXT AS journal_entry_number
    FROM bank_transactions bt
    WHERE bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.status = 'imported'
      AND bt.company_id = ${companyId}
    ORDER BY bt.transaction_date
  `) as TxRow[];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { bankAccountId } = req.query;

  if (!bankAccountId || typeof bankAccountId !== 'string' || bankAccountId.trim() === '') {
    return apiResponse.badRequest(res, 'bankAccountId query parameter is required');
  }

  try {
    // Parallel fetch: account name, latest batch, matched and unmatched transactions
    const [bankAccountName, latestBatch, matchedRows, unmatchedRows] = await Promise.all([
      fetchBankAccountName(companyId, bankAccountId),
      fetchLatestBatch(companyId, bankAccountId),
      fetchMatchedTransactions(companyId, bankAccountId),
      fetchUnmatchedTransactions(companyId, bankAccountId),
    ]);

    const mapTx = (row: TxRow) => ({
      date: toDateStr(row.transaction_date),
      description: row.description ?? '',
      amount: Number(row.amount),
      reference: row.reference ?? undefined,
      journalRef: row.journal_entry_number ?? undefined,
    });

    return apiResponse.success(res, {
      bankAccountName,
      statementDate: latestBatch ? toDateStr(latestBatch.statement_date) : '',
      openingBalance:
        latestBatch?.opening_balance !== null && latestBatch?.opening_balance !== undefined
          ? Number(latestBatch.opening_balance)
          : null,
      closingBalance:
        latestBatch?.closing_balance !== null && latestBatch?.closing_balance !== undefined
          ? Number(latestBatch.closing_balance)
          : null,
      matchedTransactions: matchedRows.map(mapTx),
      unmatchedTransactions: unmatchedRows.map(mapTx),
    });
  } catch (err) {
    log.error('Failed to get bank reconciliation report data', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get bank reconciliation report data');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
