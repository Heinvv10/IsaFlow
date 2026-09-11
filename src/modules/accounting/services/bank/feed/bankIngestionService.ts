// src/modules/accounting/services/bank/feed/bankIngestionService.ts
/**
 * Canonical bank-feed ingestion (spec §1, §2, §6). Order:
 *   lease connection -> validate -> open sync log -> identity-specific persist
 *   -> suggestion-only rules (savepoint) -> close log.
 * Every refusal is decided before the first bank_transactions write and is
 * recorded as a failed sync log, which the caller's 4xx COMMITs. Nothing here
 * posts a journal: no applyRules, no auto-post sweep, no transfer auto-link.
 */
import { sql, withSavepoint, assertTxUsable } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BANK_SUBTYPES } from '../../gl/accountSubtypes';
import { applySuggestionRules } from '../bankRulesSuggestionPass';
import { decideFeedTransition } from './bankFeedLifecycle';
import { identityModeFor, validateBatch } from './bankIngestionValidation';
import {
  applyFeedUpdate, bankAccountIsValid, closeSyncLogFailed, closeSyncLogSuccess, createImportBatch,
  existingContentHashes, insertFeedRow, leaseConnection, lockExistingByProviderIds, openSyncLog,
  touchSeen, upsertConflict, type IngestConnection,
} from './bankIngestionPersistence';
import {
  BankIngestionRefusal, isBankIngestionRefusal, type BankIngestionBatch, type BankIngestionCounts,
  type BankIngestionResult, type NormalizedBankTransaction,
} from './bankIngestionTypes';

const emptyCounts = (found: number): BankIngestionCounts =>
  ({ found, inserted: 0, updated: 0, duplicate: 0, pending: 0, removed: 0, conflicts: 0, ignored: 0 });

interface LeasedConnection extends IngestConnection { active: boolean }

async function acquire(companyId: string, connectionId: string): Promise<LeasedConnection> {
  let row: DbRow | null;
  try {
    row = await withSavepoint('bank_feed_lease', () => leaseConnection(companyId, connectionId));
  } catch (err) {
    if ((err as { code?: string }).code === '55P03') {
      throw new BankIngestionRefusal('SYNC_IN_PROGRESS', 'A sync for this connection is already running.');
    }
    throw err;
  }
  if (!row) throw new BankIngestionRefusal('CONNECTION_NOT_FOUND', 'Bank feed connection not found.');
  return {
    id: String(row.id),
    provider: String(row.provider),
    bankAccountId: String(row.bank_account_id ?? ''),
    active: Boolean(row.is_active) && String(row.status ?? 'active') === 'active',
  };
}

async function preflight(companyId: string, conn: LeasedConnection, batch: BankIngestionBatch): Promise<void> {
  if (!conn.active) {
    throw new BankIngestionRefusal('CONNECTION_INACTIVE', 'Bank feed connection is not active.');
  }
  if (!conn.bankAccountId || !(await bankAccountIsValid(companyId, conn.bankAccountId, BANK_SUBTYPES))) {
    throw new BankIngestionRefusal('BANK_ACCOUNT_INVALID', 'The connection is not linked to an active bank account in this company.');
  }
  validateBatch(batch, identityModeFor(conn.provider));
}

async function persistProviderRows(companyId: string, conn: IngestConnection, batchId: string, txs: NormalizedBankTransaction[], c: BankIngestionCounts): Promise<void> {
  const ids = txs.map((t) => (t.identity.kind === 'provider' ? t.identity.providerTransactionId : ''));
  const existing = await lockExistingByProviderIds(companyId, conn.id, ids);
  for (const t of txs) {
    const pid = t.identity.kind === 'provider' ? t.identity.providerTransactionId : '';
    const ex = existing.get(pid) ?? null;
    const d = decideFeedTransition(ex, t);
    switch (d.kind) {
      case 'insert': {
        const id = await insertFeedRow(companyId, conn, batchId, t);
        if (id) { c.inserted++; if (t.state === 'pending') c.pending++; } else c.duplicate++;
        break;
      }
      case 'ignore_removed_unknown': c.ignored++; break;
      case 'duplicate': {
        if (!ex) throw new Error('decideFeedTransition returned duplicate with no existing row');
        c.duplicate++; await touchSeen(companyId, ex.id); break;
      }
      case 'refresh':
      case 'post_pending':
      case 'remove_pending': {
        if (!ex) throw new Error(`decideFeedTransition returned ${d.kind} with no existing row`);
        const next = d.kind === 'remove_pending' ? 'removed' : d.kind === 'post_pending' ? 'posted' : ex.feedState as 'pending' | 'posted';
        const ok = await applyFeedUpdate(companyId, ex.id, ex.feedState as 'pending' | 'posted', t, next);
        if (!ok) { await upsertConflict(companyId, conn.id, ex.id, t, 'processed_row_changed'); c.conflicts++; break; }
        if (next === 'removed') c.removed++; else c.updated++;
        if (next === 'pending') c.pending++;
        break;
      }
      case 'conflict': {
        if (!ex) throw new Error('decideFeedTransition returned conflict with no existing row');
        await upsertConflict(companyId, conn.id, ex.id, t, d.reason); c.conflicts++; break;
      }
    }
  }
}

async function persistContentHashRows(companyId: string, conn: IngestConnection, batchId: string, txs: NormalizedBankTransaction[], c: BankIngestionCounts): Promise<void> {
  const dates = txs.map((t) => t.transactionDate).sort();
  const known = await existingContentHashes(companyId, conn.bankAccountId, dates[0]!, dates[dates.length - 1]!);
  for (const t of txs) {
    const hash = t.identity.kind === 'content_hash' ? t.identity.contentHash : '';
    // Set semantics against EXISTING rows only, so two identical rows in one batch both insert (two real fees).
    if (known.has(hash)) { c.duplicate++; continue; }
    if (await insertFeedRow(companyId, conn, batchId, t)) c.inserted++;
  }
}

async function suggest(companyId: string, bankAccountId: string, warnings: string[]): Promise<number> {
  try {
    return await withSavepoint('bank_feed_suggest', async () => {
      const rules = (await sql`
        SELECT * FROM bank_categorisation_rules
        WHERE company_id = ${companyId}::UUID AND is_active = true AND auto_create_entry = false
        ORDER BY priority ASC`) as Record<string, unknown>[];
      if (rules.length === 0) return 0;
      return (await applySuggestionRules(companyId, bankAccountId, rules)).length;
    });
  } catch (err) {
    assertTxUsable();
    log.warn('Feed ingestion: suggestion rules failed', { error: err instanceof Error ? err.message : String(err) }, 'bank-feed');
    warnings.push('Rule suggestions could not be applied — run bank rules from the transactions page.');
    return 0;
  }
}

export async function ingestBankBatch(
  companyId: string, batch: BankIngestionBatch, opts: { userId: string; sourceLabel: string; bankFormat: string | null },
): Promise<BankIngestionResult> {
  const connectionId = batch.source.connectionId;
  const conn = await acquire(companyId, connectionId);
  const logId = await openSyncLog(companyId, conn.id);
  try {
    await preflight(companyId, conn, batch);
  } catch (err) {
    if (isBankIngestionRefusal(err)) await closeSyncLogFailed(companyId, logId, conn.id, err.code, err.message);
    throw err;
  }

  const counts = emptyCounts(batch.transactions.length);
  const warnings: string[] = [];
  let importBatchId: string | null = null;
  if (batch.transactions.length > 0) {
    const statementDate = batch.transactions.map((t) => t.transactionDate).sort().at(-1)!;
    importBatchId = await createImportBatch(companyId, conn.bankAccountId, statementDate,
      batch.transactions.length, opts.sourceLabel, opts.bankFormat, opts.userId);
    if (identityModeFor(conn.provider) === 'provider') await persistProviderRows(companyId, conn, importBatchId, batch.transactions, counts);
    else await persistContentHashRows(companyId, conn, importBatchId, batch.transactions, counts);
  }

  const appliedSuggestions = counts.inserted + counts.updated > 0 ? await suggest(companyId, conn.bankAccountId, warnings) : 0;
  await closeSyncLogSuccess(companyId, logId, conn.id, counts);
  log.info('Bank feed batch ingested', { companyId, connectionId, ...counts, appliedSuggestions }, 'bank-feed');
  return { logId, importBatchId, counts, appliedSuggestions, warnings };
}
