/**
 * Agent-facing bank statement import.
 *
 * Dedup for statement imports currently lives in the endpoint layer —
 * bank-transactions-bulk-commit, bank-transactions-bulk-preview and
 * bank-feeds/[id]/extension-ingest each carry their own copy, while
 * importParsedTransactions does none. A caller built on the service alone
 * therefore duplicates the bank on every retry, which an agent (unlike a
 * human clicking through a preview) will do routinely. This module is the
 * shared parse → dedup → persist path those callers should have had.
 *
 * It posts nothing: the auto-post sweep is suppressed so that every
 * agent-caused posting keeps arriving through allocate_bank_transaction,
 * which stamps mcp:* and is reversible.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { parseStatement, type StatementFileType } from './bankStatementParseService';
import { importParsedTransactions } from './bankImportService';
import { deleteTransactions } from './bankTransactionQueryService';
import {
  bankTransactionHash,
  type HashableTransaction,
} from '../../utils/bankTransactionHash';
import type { BankFormat, ParsedBankTransaction } from '../../types/bank.types';

export interface AgentImportArgs {
  companyId: string;
  bankAccountId: string;
  fileType: StatementFileType;
  content: string;
  statementDate: string;
  bankFormat?: BankFormat;
  dryRun?: boolean;
  importedBy?: string;
  sourceFilename?: string;
}

export interface AgentImportResult {
  /** null for a dry run, an empty statement, or an all-duplicate statement. */
  batchId: string | null;
  imported: number;
  duplicates: number;
  parseErrors: Array<{ row: number; error: string }>;
  dateRange: { from: string; to: string } | null;
  netTotal: number;
}

/**
 * A "bank account" for import purposes is a GL account with
 * account_subtype='bank' — NOT a bank_accounts row. Migration 446 dropped
 * bank_import_batches' FK to bank_accounts for exactly this reason ("drop the
 * broken FK so writes succeed"). This mirrors the check in
 * bank-transactions-bulk-commit so both paths accept the same ids.
 */
export async function bankGlAccountBelongsToCompany(
  companyId: string,
  bankAccountId: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE id = ${bankAccountId}::UUID
      AND company_id = ${companyId}::UUID
      AND account_subtype = 'bank'
      AND is_active = true
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

function hashOf(tx: { transactionDate: string; amount: number; description?: string | null }): string {
  const hashable: HashableTransaction = {
    transactionDate: tx.transactionDate,
    amount: Number(tx.amount),
    description: tx.description ?? '',
  };
  return bankTransactionHash(hashable);
}

function dateRangeOf(txs: ParsedBankTransaction[]): { from: string; to: string } | null {
  const dates = txs
    .map((t) => t.transactionDate)
    .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d))
    .sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  return from && to ? { from, to } : null;
}

/** Hashes of rows already on this account inside the statement's date window. */
async function existingHashes(
  companyId: string,
  bankAccountId: string,
  range: { from: string; to: string },
): Promise<Set<string>> {
  // Scoped by company_id as well as bank_account_id. The sibling endpoints
  // filter on bank_account_id alone; the account is company-scoped so it is
  // not exploitable there, but the repo rule is company_id on every query.
  const rows = (await sql`
    SELECT transaction_date::text AS transaction_date, amount, description
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND bank_account_id = ${bankAccountId}::UUID
      AND transaction_date BETWEEN ${range.from}::DATE AND ${range.to}::DATE
  `) as Array<{ transaction_date: string; amount: string | number; description: string | null }>;

  const out = new Set<string>();
  for (const row of rows) {
    out.add(hashOf({
      transactionDate: row.transaction_date,
      amount: Number(row.amount),
      description: row.description,
    }));
  }
  return out;
}

export async function importStatementForAgent(args: AgentImportArgs): Promise<AgentImportResult> {
  const parseResult = await parseStatement({
    fileType: args.fileType,
    csvContent: args.content,
    bankFormat: args.bankFormat,
  });

  const parseErrors = parseResult.errors ?? [];
  const empty: AgentImportResult = {
    batchId: null, imported: 0, duplicates: 0, parseErrors, dateRange: null, netTotal: 0,
  };
  if (parseResult.transactions.length === 0) return empty;

  const range = dateRangeOf(parseResult.transactions);
  const seen = range ? await existingHashes(args.companyId, args.bankAccountId, range) : new Set<string>();

  const fresh: ParsedBankTransaction[] = [];
  let duplicates = 0;
  for (const tx of parseResult.transactions) {
    if (seen.has(hashOf(tx))) {
      duplicates++;
      continue;
    }
    fresh.push(tx);
  }

  const netTotal = fresh.reduce((sum, tx) => sum + Number(tx.amount), 0);
  const summary = { imported: fresh.length, duplicates, parseErrors, dateRange: range, netTotal };

  // summary.imported is already fresh.length, which is what both cases want:
  // a dry run reports what would land, and the non-dry-run case is only
  // reachable here when fresh.length is 0.
  if (args.dryRun || fresh.length === 0) {
    return { ...summary, batchId: null };
  }

  const result = await importParsedTransactions(
    args.companyId,
    { ...parseResult, transactions: fresh },
    args.bankAccountId,
    args.statementDate,
    {
      importedBy: args.importedBy,
      sourceFilename: args.sourceFilename,
      // Importing must not post. See the module comment.
      skipAutoPost: true,
    },
  );

  log.info('Agent bank statement import', {
    companyId: args.companyId,
    batchId: result.batchId,
    imported: fresh.length,
    duplicates,
  }, 'accounting');

  return { ...summary, batchId: result.batchId || null };
}

/**
 * Undo an import batch. Deletes only rows still in 'imported' status —
 * deleteTransactions enforces that — and reports what was left behind so a
 * caller cannot mistake a partial undo for a clean one.
 *
 * The refusals are broken down BY STATUS rather than reported as one
 * "allocated" number: bank_transactions.status is one of imported/allocated/
 * matched/reconciled/excluded, and only 'allocated' is undoable with
 * reverse_bank_allocation. Collapsing them would hand the caller a recovery
 * instruction that does not apply to a reconciled or excluded row.
 *
 * Returns null when the batch does not belong to this company.
 */
export async function undoImportBatch(
  companyId: string,
  batchId: string,
): Promise<{ deleted: number; refused: number; refusedByStatus: Record<string, number> } | null> {
  const batch = (await sql`
    SELECT id FROM bank_import_batches
    WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Array<{ id: string }>;
  if (batch.length === 0) return null;

  const rows = (await sql`
    SELECT id, status FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND import_batch_id = ${batchId}::UUID
  `) as Array<{ id: string; status: string }>;

  const importedIds = rows.filter((r) => r.status === 'imported').map((r) => String(r.id));
  const refused = rows.length - importedIds.length;
  const refusedByStatus: Record<string, number> = {};
  for (const row of rows) {
    if (row.status === 'imported') continue;
    refusedByStatus[row.status] = (refusedByStatus[row.status] ?? 0) + 1;
  }
  const deleted = importedIds.length > 0 ? await deleteTransactions(companyId, importedIds) : 0;

  log.info('Agent bank import undone', {
    companyId, batchId, deleted, refused, refusedByStatus,
  }, 'accounting');
  return { deleted, refused, refusedByStatus };
}
