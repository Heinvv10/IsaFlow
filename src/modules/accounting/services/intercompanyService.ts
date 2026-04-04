/**
 * Intercompany Transactions Service
 * Manages intercompany transactions and reconciliation within company groups.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface IntercompanyTransaction {
  id: string;
  groupId: string;
  sourceCompanyId: string;
  sourceCompanyName?: string;
  targetCompanyId: string;
  targetCompanyName?: string;
  sourceJournalEntryId: string | null;
  targetJournalEntryId: string | null;
  transactionType: string;
  amount: number;
  currency: string;
  description: string | null;
  transactionDate: string;
  matchStatus: string;
  varianceAmount: number;
  matchedAt: string | null;
  matchedBy: string | null;
  createdAt: string;
}

export interface IntercompanyReconciliation {
  totalTransactions: number;
  matched: number;
  unmatched: number;
  partial: number;
  variance: number;
  totalAmount: number;
  matchedAmount: number;
  unmatchedAmount: number;
  varianceTotal: number;
  transactions: IntercompanyTransaction[];
}

export interface IntercompanyFilters {
  dateFrom?: string;
  dateTo?: string;
  matchStatus?: string;
  sourceCompanyId?: string;
  targetCompanyId?: string;
  transactionType?: string;
}

export function mapIntercompanyTx(r: Row): IntercompanyTransaction {
  return {
    id: String(r.id),
    groupId: String(r.group_id),
    sourceCompanyId: String(r.source_company_id),
    sourceCompanyName: r.source_company_name != null ? String(r.source_company_name) : undefined,
    targetCompanyId: String(r.target_company_id),
    targetCompanyName: r.target_company_name != null ? String(r.target_company_name) : undefined,
    sourceJournalEntryId: r.source_journal_entry_id != null ? String(r.source_journal_entry_id) : null,
    targetJournalEntryId: r.target_journal_entry_id != null ? String(r.target_journal_entry_id) : null,
    transactionType: String(r.transaction_type),
    amount: Number(r.amount),
    currency: String(r.currency),
    description: r.description != null ? String(r.description) : null,
    transactionDate: String(r.transaction_date),
    matchStatus: String(r.match_status),
    varianceAmount: Number(r.variance_amount),
    matchedAt: r.matched_at != null ? String(r.matched_at) : null,
    matchedBy: r.matched_by != null ? String(r.matched_by) : null,
    createdAt: String(r.created_at),
  };
}

export async function listIntercompanyTransactions(
  groupId: string,
  filters?: IntercompanyFilters,
): Promise<IntercompanyTransaction[]> {
  const rows = (await sql`
    SELECT it.*,
           sc.name AS source_company_name,
           tc.name AS target_company_name
    FROM intercompany_transactions it
    JOIN companies sc ON sc.id = it.source_company_id
    JOIN companies tc ON tc.id = it.target_company_id
    WHERE it.group_id = ${groupId}::UUID
      AND (${filters?.dateFrom || null}::DATE IS NULL OR it.transaction_date >= ${filters?.dateFrom || null}::DATE)
      AND (${filters?.dateTo || null}::DATE IS NULL OR it.transaction_date <= ${filters?.dateTo || null}::DATE)
      AND (${filters?.matchStatus || null}::TEXT IS NULL OR it.match_status = ${filters?.matchStatus || null})
      AND (${filters?.sourceCompanyId || null}::UUID IS NULL OR it.source_company_id = ${filters?.sourceCompanyId || null}::UUID)
      AND (${filters?.targetCompanyId || null}::UUID IS NULL OR it.target_company_id = ${filters?.targetCompanyId || null}::UUID)
      AND (${filters?.transactionType || null}::TEXT IS NULL OR it.transaction_type = ${filters?.transactionType || null})
    ORDER BY it.transaction_date DESC, it.created_at DESC
  `) as Row[];
  return rows.map(mapIntercompanyTx);
}

export async function createIntercompanyTransaction(input: {
  groupId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  sourceJournalEntryId?: string;
  targetJournalEntryId?: string;
  transactionType: string;
  amount: number;
  currency?: string;
  description?: string;
  transactionDate: string;
}): Promise<IntercompanyTransaction> {
  const rows = (await sql`
    INSERT INTO intercompany_transactions (
      group_id, source_company_id, target_company_id,
      source_journal_entry_id, target_journal_entry_id,
      transaction_type, amount, currency, description, transaction_date
    )
    VALUES (
      ${input.groupId}::UUID,
      ${input.sourceCompanyId}::UUID,
      ${input.targetCompanyId}::UUID,
      ${input.sourceJournalEntryId || null},
      ${input.targetJournalEntryId || null},
      ${input.transactionType},
      ${input.amount},
      ${input.currency || 'ZAR'},
      ${input.description || null},
      ${input.transactionDate}::DATE
    )
    RETURNING *
  `) as Row[];
  log.info('Intercompany transaction created', {
    id: rows[0]!.id,
    groupId: input.groupId,
    type: input.transactionType,
    amount: input.amount,
  }, 'accounting');
  return mapIntercompanyTx(rows[0]!);
}

export async function matchIntercompanyTransactions(
  sourceId: string,
  targetId: string,
): Promise<void> {
  const sources = (await sql`SELECT * FROM intercompany_transactions WHERE id = ${sourceId}::UUID`) as Row[];
  const targets = (await sql`SELECT * FROM intercompany_transactions WHERE id = ${targetId}::UUID`) as Row[];

  if (!sources[0] || !targets[0]) {
    throw new Error('One or both intercompany transactions not found');
  }

  const source = sources[0]!;
  const target = targets[0]!;
  const variance = Math.abs(Number(source.amount) - Number(target.amount));
  const status = variance === 0 ? 'matched' : 'variance';

  await sql`
    UPDATE intercompany_transactions SET
      match_status = ${status},
      variance_amount = ${variance},
      matched_at = NOW()
    WHERE id IN (${sourceId}::UUID, ${targetId}::UUID)
  `;

  log.info('Intercompany transactions matched', { sourceId, targetId, status, variance }, 'accounting');
}

export async function getIntercompanyReconciliation(
  groupId: string,
  periodStart: string,
  periodEnd: string,
): Promise<IntercompanyReconciliation> {
  const rows = (await sql`
    SELECT it.*,
           sc.name AS source_company_name,
           tc.name AS target_company_name
    FROM intercompany_transactions it
    JOIN companies sc ON sc.id = it.source_company_id
    JOIN companies tc ON tc.id = it.target_company_id
    WHERE it.group_id = ${groupId}::UUID
      AND it.transaction_date >= ${periodStart}::DATE
      AND it.transaction_date <= ${periodEnd}::DATE
    ORDER BY it.transaction_date DESC
  `) as Row[];

  const transactions = rows.map(mapIntercompanyTx);
  const matched = transactions.filter(t => t.matchStatus === 'matched');
  const unmatched = transactions.filter(t => t.matchStatus === 'unmatched');
  const partial = transactions.filter(t => t.matchStatus === 'partial');
  const withVariance = transactions.filter(t => t.matchStatus === 'variance');

  return {
    totalTransactions: transactions.length,
    matched: matched.length,
    unmatched: unmatched.length,
    partial: partial.length,
    variance: withVariance.length,
    totalAmount: transactions.reduce((sum, t) => sum + t.amount, 0),
    matchedAmount: matched.reduce((sum, t) => sum + t.amount, 0),
    unmatchedAmount: unmatched.reduce((sum, t) => sum + t.amount, 0),
    varianceTotal: withVariance.reduce((sum, t) => sum + t.varianceAmount, 0),
    transactions,
  };
}
