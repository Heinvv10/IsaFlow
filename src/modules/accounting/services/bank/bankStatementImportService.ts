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
 *
 * KNOWN LIMIT — dedup can discard a genuine transaction. The content hash is
 * (date, amount, description); bankTransactionHash also accepts `balance`,
 * which is what distinguishes two same-day, same-amount, same-merchant
 * transactions, but `bank_transactions` has no balance column so it cannot be
 * supplied on the DB side. Two identical R25 purchases on one day therefore
 * hash alike, and a second overlapping statement will count the second one as
 * a duplicate and drop it. The bias is deliberate: under-importing is visible
 * in a bank reconciliation, whereas double-importing silently inflates the
 * ledger. Callers should reconcile the closing balance after importing rather
 * than trust the row count.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { StatementNotImportableError } from './bankStatementImportErrors';
import { parseStatement, type StatementFileType } from './bankStatementParseService';
import { importParsedTransactions } from './bankImportService';
import { deleteTransactions } from './bankTransactionQueryService';
import {
  bankTransactionHash,
  type HashableTransaction,
} from '../../utils/bankTransactionHash';
import type { BankFormat, ParsedBankTransaction } from '../../types/bank.types';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';

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
 *
 * It deliberately does NOT require `account_type = 'asset'`. Whether a balance
 * counts as CASH is a different question, owned by `cashBalanceService`, and
 * answering it here refused statement imports for an overdraft or credit card
 * typed `liability` — an account that already holds bank_transactions and is
 * still offered by /api/accounting/bank-accounts, bulk preview, bulk commit and
 * the feed pairing. The importer must accept every id those paths accept; the
 * coverage report flags the mis-classification instead.
 */
export async function bankGlAccountBelongsToCompany(
  companyId: string,
  bankAccountId: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT id FROM gl_accounts
    WHERE id = ${bankAccountId}::UUID
      AND company_id = ${companyId}::UUID
      AND account_subtype = ANY(${BANK_SUBTYPES as string[]})
      AND is_active = true
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Round to 2dp the way Postgres does, not the way JS does.
 *
 * `bank_transactions.amount` is NUMERIC(15,2), and Postgres rounds halves AWAY
 * FROM ZERO; `Math.round` (which bankTransactionHash uses internally) rounds
 * halves toward +Infinity. They disagree on every negative half-cent:
 * -25.005 stores as -25.01 but hashes as -25.00. The stored row and the
 * statement line it came from then hash differently forever, so the row is
 * re-imported on every retry — breaking exactly the "re-sending the same
 * statement is safe" property this service exists to provide.
 *
 * Applied to BOTH sides. On the DB side the value is already rounded, so this
 * is a no-op there; on the parsed side it is the fix.
 */
function round2(n: number): number {
  const scaled = n * 100;
  return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / 100;
}

function hashOf(tx: { transactionDate: string; amount: number; description?: string | null }): string {
  const hashable: HashableTransaction = {
    transactionDate: tx.transactionDate,
    amount: round2(Number(tx.amount)),
    description: tx.description ?? '',
  };
  return bankTransactionHash(hashable);
}

/**
 * The shape check is not enough on its own: the OFX and MT940 parsers only
 * reject day > 31, so `<DTPOSTED>20260231` becomes the well-formed but
 * non-existent '2026-02-31'. Interpolated into `${from}::DATE` that raises
 * SQLSTATE 22008 on the request connection, aborting the surrounding
 * transaction and surfacing as a generic failure instead of a usable message.
 * Round-tripping through Date catches it here, where we can say what is wrong.
 */
function isRealCalendarDate(d: string): boolean {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return false;
  const probe = new Date(Date.UTC(y, m - 1, day));
  return probe.getUTCFullYear() === y
    && probe.getUTCMonth() === m - 1
    && probe.getUTCDate() === day;
}

function dateRangeOf(txs: ParsedBankTransaction[]): { from: string; to: string } | null {
  const dates = txs
    .map((t) => t.transactionDate)
    .filter((d): d is string =>
      typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) && isRealCalendarDate(d))
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

  // A null range means not one parsed row carried a recognisable ISO date.
  // Continuing would query nothing, leave `seen` empty, and import every row
  // with dedup silently switched off — the failure mode is a duplicated bank,
  // and it is invisible because the result still reports duplicates: 0.
  // Refuse instead. (The parser emits 5-digit years verbatim and Postgres
  // accepts them, so this is reachable from a malformed statement.)
  const range = dateRangeOf(parseResult.transactions);
  if (!range) {
    throw new StatementNotImportableError(
      'No transaction in this statement has a recognisable YYYY-MM-DD date, so duplicates cannot be detected. Check the statement dates and re-send.',
    );
  }
  const seen = await existingHashes(args.companyId, args.bankAccountId, range);

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
      // Insert only: no posting, and no touching rows this import did not
      // create. See the option's own comment in bankImportService.
      skipPostImportEffects: true,
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
  // imported_by is NOT decoration here — it is the authorisation boundary.
  // list_bank_transactions returns import_batch_id for every row, so without
  // this filter an agent can read a human's UI batch id straight out of a read
  // tool and hard-delete that batch. Deletion is unrecoverable, and with
  // auto-post off (the default) every row in a human batch is still
  // 'imported', so the whole batch would go. Undo reaches agent imports only.
  const batch = (await sql`
    SELECT id FROM bank_import_batches
    WHERE id = ${batchId}::UUID
      AND company_id = ${companyId}::UUID
      AND imported_by LIKE 'mcp:%'
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

export { StatementNotImportableError };
