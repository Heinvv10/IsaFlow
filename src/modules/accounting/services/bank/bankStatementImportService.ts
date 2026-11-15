/**
 * Agent-facing bank statement import.
 *
 * importParsedTransactions does no dedup: its callers do. A caller built on
 * that service alone therefore duplicates the bank on every retry, which an
 * agent (unlike a human clicking through a preview) will do routinely. This
 * module is the parse → dedup → persist path for the agent; the dedup read is
 * the one bulk-commit shares (./bankStatementDedupe), taken under the
 * account's ingest lock (./bankIngestLock, WP2-2).
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
import type { BankFormat, ParsedBankTransaction } from '../../types/bank.types';
import { assertBankAccountInCompany, isBankAccountGuardRefusal, type BankAccountGuardOpts } from './bankAccountGuard';
import { dateRangeOf } from './bankStatementDateRange';
import { existingStatementHashes, statementLineHash } from './bankStatementDedupe';
import { lockBankAccountIngest } from './bankIngestLock';
import type { ImportProvenance } from './importProvenance';

export interface AgentImportArgs {
  companyId: string;
  bankAccountId: string;
  fileType: StatementFileType;
  content: string;
  statementDate: string;
  bankFormat?: BankFormat;
  dryRun?: boolean;
  provenance?: ImportProvenance; // who (the token's user), the channel, the content's hash
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
 * a bank subtype (bank/bankAccountGuard) — NOT a bank_accounts row. Migration 446 dropped
 * bank_import_batches' FK to bank_accounts for exactly this reason ("drop the
 * broken FK so writes succeed"). It IS the guard bulk commit and every
 * bank-account route run, so all of them accept the same ids.
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
  opts: BankAccountGuardOpts = {},
): Promise<boolean> {
  // The guard's own test (WP2-1 r3): isBankSubtype, active, the row held FOR SHARE (5 s bound) to the call's end —
  // or, for a read-only tool, `{ lock: false }`: the same test, no lock (r4).
  try {
    await assertBankAccountInCompany(companyId, bankAccountId, opts);
    return true;
  } catch (err) {
    if (isBankAccountGuardRefusal(err)) return false;
    throw err;
  }
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
  // WP2-2: the account's ingest lock BEFORE the dedup read, so a concurrent import of the same statement waits here
  // and then reads this one's lines. A dry run writes nothing, so it does not queue.
  if (!args.dryRun) await lockBankAccountIngest(args.companyId, args.bankAccountId);
  const seen = await existingStatementHashes(args.companyId, args.bankAccountId, range);

  const fresh: ParsedBankTransaction[] = [];
  let duplicates = 0;
  for (const tx of parseResult.transactions) {
    if (seen.has(statementLineHash(tx))) {
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
      ...args.provenance,
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
      AND (import_channel = 'mcp' OR imported_by LIKE 'mcp:%') -- step 2: the token's user is recorded; legacy rows say mcp:*
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
