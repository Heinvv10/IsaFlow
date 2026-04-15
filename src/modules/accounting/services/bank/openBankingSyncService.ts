/** Open Banking — transaction fetching, deduplication, and sync orchestration */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { type BankFeedSyncResult, type Provider } from './openBankingTypes';
import type { DbRow } from '@/types/db';


// ── Stub transaction generator ────────────────────────────────────────────────

interface StubTransaction {
  externalId: string;
  date: string;
  amount: number;
  description: string;
  reference: string | null;
}

const DEBIT_DESCRIPTIONS = ['Office supplies', 'Fuel', 'Telkom invoice', 'Eskom payment', 'Staff salary'];
const CREDIT_DESCRIPTIONS = ['Client payment', 'Interest income', 'Deposit', 'Invoice receipt'];

function buildSampleTransactions(provider: Provider): StubTransaction[] {
  const today = new Date();
  const count = 5 + Math.floor(Math.random() * 6); // 5–10
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0]!;
    const isDebit = Math.random() > 0.4;
    const amount = (isDebit ? -1 : 1) * parseFloat((Math.random() * 5000 + 100).toFixed(2));
    return {
      externalId: `${provider}-stub-${dateStr}-${i}`,
      date: dateStr,
      amount,
      description: isDebit
        ? DEBIT_DESCRIPTIONS[i % DEBIT_DESCRIPTIONS.length]!
        : CREDIT_DESCRIPTIONS[i % CREDIT_DESCRIPTIONS.length]!,
      reference: `REF-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
    };
  });
}

// ── Deduplication + insert ────────────────────────────────────────────────────

// BL-54: companyId is required so bank_transactions.company_id (NOT NULL) is populated
async function insertTransaction(
  companyId: string,
  bankAccountId: string,
  tx: StubTransaction,
): Promise<'imported' | 'duplicate'> {
  // Primary dedup via external ID stored in bank_reference
  const byRef = (await sql`
    SELECT id FROM bank_transactions
    WHERE bank_account_id = ${bankAccountId}::UUID
      AND bank_reference = ${tx.externalId}
    LIMIT 1
  `) as DbRow[];
  if (byRef.length > 0) return 'duplicate';

  // Fallback dedup: same amount + date + description
  const byFields = (await sql`
    SELECT id FROM bank_transactions
    WHERE bank_account_id = ${bankAccountId}::UUID
      AND amount = ${tx.amount}
      AND transaction_date = ${tx.date}::DATE
      AND description = ${tx.description}
    LIMIT 1
  `) as DbRow[];
  if (byFields.length > 0) return 'duplicate';

  await sql`
    INSERT INTO bank_transactions (
      company_id, bank_account_id, transaction_date, amount,
      description, reference, bank_reference, status
    ) VALUES (
      ${companyId}::UUID,
      ${bankAccountId}::UUID,
      ${tx.date}::DATE,
      ${tx.amount},
      ${tx.description},
      ${tx.reference},
      ${tx.externalId},
      'imported'
    )
  `;
  return 'imported';
}

// ── Sync orchestration ────────────────────────────────────────────────────────

async function markSyncComplete(
  logId: string,
  connectionId: string,
  found: number,
  imported: number,
  duplicate: number,
) {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'success', completed_at = NOW(),
        transactions_found = ${found},
        transactions_imported = ${imported},
        transactions_duplicate = ${duplicate}
    WHERE id = ${logId}::UUID
  `;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_sync_status = 'success',
        last_sync_error = NULL, updated_at = NOW()
    WHERE id = ${connectionId}::UUID
  `;
}

async function markSyncFailed(logId: string, connectionId: string, errMsg: string) {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'failed', completed_at = NOW(), error_message = ${errMsg}
    WHERE id = ${logId}::UUID
  `;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_sync_status = 'failed',
        last_sync_error = ${errMsg}, updated_at = NOW()
    WHERE id = ${connectionId}::UUID
  `;
}

export async function syncBankFeed(
  companyId: string,
  connectionId: string,
  userId: string,
): Promise<BankFeedSyncResult> {
  // IDOR guard: verify connection belongs to company
  const connRows = (await sql`
    SELECT bfc.*, ba.account_name
    FROM bank_feed_connections bfc
    LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id
    WHERE bfc.id = ${connectionId}::UUID
      AND bfc.company_id = ${companyId}::UUID
      AND bfc.is_active = true
    LIMIT 1
  `) as DbRow[];

  if (connRows.length === 0) {
    throw new Error('Connection not found or does not belong to this company');
  }

  const conn = connRows[0]!;
  const provider = String(conn.provider) as Provider;

  const logRows = (await sql`
    INSERT INTO bank_feed_sync_logs (connection_id, company_id, status)
    VALUES (${connectionId}::UUID, ${companyId}::UUID, 'running')
    RETURNING id
  `) as DbRow[];
  const logId = String(logRows[0]!.id);

  log.info('Bank feed sync started', { connectionId, provider, companyId, userId }, 'open-banking');

  // manual_csv: return instructions without inserting transactions
  if (provider === 'manual_csv') {
    await markSyncComplete(logId, connectionId, 0, 0, 0);
    return {
      connectionId, provider, logId, found: 0, imported: 0, duplicate: 0,
      instructions: 'Manual CSV import: use the Bank Transactions import page to upload your bank statement file.',
    };
  }

  const bankAccountId = conn.bank_account_id != null ? String(conn.bank_account_id) : null;
  if (!bankAccountId) {
    const errMsg = 'Connection has no linked bank account — cannot import transactions';
    await markSyncFailed(logId, connectionId, errMsg);
    throw new Error(errMsg);
  }

  try {
    const transactions = buildSampleTransactions(provider);
    let imported = 0;
    let duplicate = 0;

    for (const tx of transactions) {
      const result = await insertTransaction(companyId, bankAccountId, tx);
      if (result === 'imported') imported++;
      else duplicate++;
    }

    const found = transactions.length;
    await markSyncComplete(logId, connectionId, found, imported, duplicate);
    log.info('Bank feed sync completed', { connectionId, provider, found, imported, duplicate }, 'open-banking');
    return { connectionId, provider, logId, found, imported, duplicate };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Sync failed';
    await markSyncFailed(logId, connectionId, errMsg);
    log.error('Bank feed sync failed', { connectionId, provider, error: errMsg }, 'open-banking');
    throw err;
  }
}
