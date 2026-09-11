// src/modules/accounting/services/bank/feed/bankIngestionPersistence.ts
/** SQL for canonical feed ingestion. Every statement is company-scoped. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { bankTransactionHash } from '@/modules/accounting/utils/bankTransactionHash';
import { feedStateOf } from '../bankFeedStateGuard';
import type { ConflictReason, ExistingFeedRow } from './bankFeedLifecycle';
import type { BankIngestionCounts, NormalizedBankTransaction } from './bankIngestionTypes';

export interface IngestConnection { id: string; provider: string; bankAccountId: string }

/** Lease row for this connection. FOR NO KEY UPDATE, so child FK inserts (KEY SHARE) don't block. */
export async function leaseConnection(companyId: string, connectionId: string): Promise<DbRow | null> {
  const rows = (await sql`
    SELECT id, provider, bank_account_id, is_active, status, daily_tx_cap
    FROM bank_feed_connections
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID
    FOR NO KEY UPDATE NOWAIT`) as DbRow[];
  return rows[0] ?? null;
}

/**
 * Serialise every feed ingest into one bank account, whichever connection leased
 * it: the content-hash dedup read below is otherwise a check-then-insert race
 * between two connections on the same account. Transaction-scoped; released at
 * COMMIT/ROLLBACK. Taken after the lease, before any bank_transactions read.
 */
export async function lockBankAccountForIngest(companyId: string, bankAccountId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bank_tx_ingest:${companyId}:${bankAccountId}`}::TEXT, 0))`;
}

export async function bankAccountIsValid(companyId: string, bankAccountId: string, subtypes: readonly string[]): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM gl_accounts
    WHERE id = ${bankAccountId}::UUID AND company_id = ${companyId}::UUID
      AND account_subtype = ANY(${subtypes as string[]}) AND is_active = true`) as DbRow[];
  return rows.length > 0;
}

export async function openSyncLog(companyId: string, connectionId: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO bank_feed_sync_logs (connection_id, company_id, status)
    VALUES (${connectionId}::UUID, ${companyId}::UUID, 'running') RETURNING id`) as DbRow[];
  return String(rows[0]!.id);
}

export async function closeSyncLogSuccess(companyId: string, logId: string, connectionId: string, c: BankIngestionCounts): Promise<void> {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'success', completed_at = NOW(),
        transactions_found = ${c.found}, transactions_imported = ${c.inserted},
        transactions_duplicate = ${c.duplicate}, transactions_updated = ${c.updated},
        transactions_pending = ${c.pending}, transactions_removed = ${c.removed},
        transactions_conflict = ${c.conflicts}, transactions_ignored = ${c.ignored}
    WHERE id = ${logId}::UUID AND company_id = ${companyId}::UUID`;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_success_at = NOW(), last_sync_status = 'success',
        last_sync_error = NULL, updated_at = NOW()
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID`;
}

export async function closeSyncLogFailed(companyId: string, logId: string, connectionId: string, code: string, message: string): Promise<void> {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'failed', completed_at = NOW(), error_code = ${code}, error_message = ${message}
    WHERE id = ${logId}::UUID AND company_id = ${companyId}::UUID`;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_sync_status = 'failed', last_sync_error = ${message}, updated_at = NOW()
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID`;
}

/** Written after persist, and only when rows were inserted, so a redelivery leaves no empty batch. */
export async function createImportBatch(
  companyId: string, id: string, bankAccountId: string, statementDate: string, count: number,
  sourceLabel: string, bankFormat: string | null, userId: string,
): Promise<void> {
  await sql`
    INSERT INTO bank_import_batches (id, company_id, bank_account_id, statement_date, bank_format,
      transaction_count, source_filename, imported_by)
    VALUES (${id}::UUID, ${companyId}::UUID, ${bankAccountId}::UUID, ${statementDate}::DATE, ${bankFormat},
      ${count}, ${sourceLabel}, ${userId})`;
}

/** Existing provider-identified rows, locked for the rest of the request. */
export async function lockExistingByProviderIds(
  companyId: string, connectionId: string, ids: string[],
): Promise<Map<string, ExistingFeedRow>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id, provider_transaction_id, feed_state, transaction_date, value_date, amount,
           description, reference, provider_updated_at,
           (status <> 'imported' OR matched_journal_line_id IS NOT NULL OR reconciliation_id IS NOT NULL
            OR provisional_je_id IS NOT NULL) AS processed
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND bank_feed_connection_id = ${connectionId}::UUID
      AND provider_transaction_id = ANY(${ids}::TEXT[])
    ORDER BY id
    FOR UPDATE`) as DbRow[];
  const map = new Map<string, ExistingFeedRow>();
  for (const r of rows) {
    map.set(String(r.provider_transaction_id), {
      id: String(r.id),
      feedState: feedStateOf(r),
      processed: Boolean(r.processed),
      transactionDate: fmtDate(r.transaction_date),
      valueDate: r.value_date ? fmtDate(r.value_date) : null,
      amount: Number(r.amount),
      description: String(r.description ?? ''),
      reference: r.reference != null ? String(r.reference) : null,
      providerUpdatedAt: r.provider_updated_at != null ? new Date(r.provider_updated_at as string | Date).toISOString() : null,
    });
  }
  return map;
}

/** Hashes of rows already on this bank account inside [from, to] — the established statement/extension dedup. */
export async function existingContentHashes(
  companyId: string, bankAccountId: string, from: string, to: string,
): Promise<Set<string>> {
  const rows = (await sql`
    SELECT transaction_date, amount, description FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND bank_account_id = ${bankAccountId}::UUID
      AND transaction_date BETWEEN ${from}::DATE AND ${to}::DATE`) as DbRow[];
  return new Set(rows.map((r) => bankTransactionHash({
    transactionDate: fmtDate(r.transaction_date), amount: Number(r.amount), description: String(r.description ?? ''),
  })));
}

export async function insertFeedRow(
  companyId: string, conn: IngestConnection, batchId: string, t: NormalizedBankTransaction,
): Promise<string | null> {
  const providerId = t.identity.kind === 'provider' ? t.identity.providerTransactionId : null;
  const rows = (await sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, value_date, amount,
      description, reference, import_batch_id, bank_feed_connection_id, provider_transaction_id,
      feed_state, provider_updated_at, feed_last_seen_at)
    VALUES (${companyId}::UUID, ${conn.bankAccountId}::UUID, ${t.transactionDate}::DATE, ${t.valueDate ?? null}::DATE,
      ${t.amount}, ${t.description}, ${t.reference ?? null}, ${batchId}::UUID, ${conn.id}::UUID, ${providerId},
      ${t.state}, ${t.providerUpdatedAt ?? null}::TIMESTAMPTZ, NOW())
    ON CONFLICT (company_id, bank_feed_connection_id, provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL DO NOTHING
    RETURNING id`) as DbRow[];
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * Apply a refresh / post_pending / remove_pending. The WHERE repeats the
 * decision's preconditions, so a row that changed under us updates nothing
 * and the caller records a conflict instead.
 */
export async function applyFeedUpdate(
  companyId: string, rowId: string, expectedState: 'pending' | 'posted', t: NormalizedBankTransaction, nextState: 'pending' | 'posted' | 'removed',
): Promise<boolean> {
  const rows = (await sql`
    UPDATE bank_transactions
    SET transaction_date = ${t.transactionDate}::DATE, value_date = ${t.valueDate ?? null}::DATE,
        amount = ${t.amount}, description = ${t.description}, reference = ${t.reference ?? null},
        feed_state = ${nextState},
        -- Never backwards: GREATEST ignores NULLs, so a missing timestamp keeps the stored one.
        provider_updated_at = GREATEST(${t.providerUpdatedAt ?? null}::TIMESTAMPTZ, provider_updated_at),
        feed_last_seen_at = NOW(), updated_at = NOW()
    WHERE id = ${rowId}::UUID AND company_id = ${companyId}::UUID AND feed_state = ${expectedState}
      AND status = 'imported' AND matched_journal_line_id IS NULL AND reconciliation_id IS NULL
      AND provisional_je_id IS NULL
    RETURNING id`) as DbRow[];
  return rows.length > 0;
}

export async function touchSeen(companyId: string, rowId: string): Promise<void> {
  await sql`UPDATE bank_transactions SET feed_last_seen_at = NOW()
            WHERE id = ${rowId}::UUID AND company_id = ${companyId}::UUID`;
}

export async function upsertConflict(
  companyId: string, connectionId: string, rowId: string, t: NormalizedBankTransaction, reason: ConflictReason,
): Promise<void> {
  const providerId = t.identity.kind === 'provider' ? t.identity.providerTransactionId : '';
  // The validated, normalised transaction only, never a raw provider payload.
  const proposed = JSON.stringify({
    state: t.state, transactionDate: t.transactionDate, valueDate: t.valueDate ?? null, amount: t.amount,
    description: t.description, reference: t.reference ?? null, providerUpdatedAt: t.providerUpdatedAt ?? null,
  });
  await sql`
    INSERT INTO bank_feed_transaction_conflicts (company_id, connection_id, bank_transaction_id,
      provider_transaction_id, reason, proposed)
    VALUES (${companyId}::UUID, ${connectionId}::UUID, ${rowId}::UUID, ${providerId}, ${reason}, ${proposed}::JSONB)
    ON CONFLICT (company_id, connection_id, provider_transaction_id) WHERE resolved_at IS NULL
    DO UPDATE SET proposed = EXCLUDED.proposed, reason = EXCLUDED.reason, last_seen_at = NOW()`;
}
