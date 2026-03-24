/**
 * Accounting Adjustment Service
 * Phase 1 Sage Alignment: Customer & supplier balance adjustments
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getAccountByCode } from './chartOfAccountsService';
import type { AccountingAdjustment, AdjustmentCreateInput } from '../types/ar.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export async function getAdjustments(filters?: {
  entityType?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: AccountingAdjustment[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.entityType) {
    rows = (await sql`
      SELECT * FROM accounting_adjustments
      WHERE entity_type = ${filters.entityType}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM accounting_adjustments WHERE entity_type = ${filters.entityType}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM accounting_adjustments
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM accounting_adjustments`) as Row[];
  }

  // Resolve entity names
  const items: AccountingAdjustment[] = [];
  for (const row of rows) {
    const mapped = mapRow(row);
    if (row.entity_type === 'customer') {
      const c = (await sql`SELECT company_name FROM clients WHERE id = ${row.entity_id}::UUID`) as Row[];
      mapped.entityName = c[0]?.company_name ? String(c[0].company_name) : 'Unknown';
    } else {
      const s = (await sql`SELECT company_name FROM suppliers WHERE id = ${row.entity_id}::UUID`) as Row[];
      mapped.entityName = s[0]?.company_name ? String(s[0].company_name) : 'Unknown';
    }
    items.push(mapped);
  }

  return { items, total: Number(countRows[0]?.cnt || 0) };
}

export async function createAdjustment(
  input: AdjustmentCreateInput,
  userId: string
): Promise<AccountingAdjustment> {
  const rows = (await sql`
    INSERT INTO accounting_adjustments (
      entity_type, entity_id, adjustment_type, amount, reason,
      adjustment_date, created_by
    ) VALUES (
      ${input.entityType}, ${input.entityId}::UUID, ${input.adjustmentType},
      ${input.amount}, ${input.reason},
      ${input.adjustmentDate || new Date().toISOString().split('T')[0]},
      ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created adjustment', { id: rows[0]?.id, type: input.entityType }, 'accounting');
  return mapRow(rows[0]!);
}

export async function approveAdjustment(id: string, userId: string): Promise<AccountingAdjustment> {
  const adjRows = (await sql`SELECT * FROM accounting_adjustments WHERE id = ${id}`) as Row[];
  if (!adjRows[0]) throw new Error('Adjustment not found');
  if (adjRows[0].status !== 'draft') throw new Error('Adjustment is not in draft status');

  const adj = adjRows[0];
  const amount = Number(adj.amount);
  const isCustomer = adj.entity_type === 'customer';
  const isDebit = adj.adjustment_type === 'debit';

  // GL accounts
  const balanceAccount = isCustomer
    ? await getAccountByCode('1120') // AR
    : await getAccountByCode('2110'); // AP
  const incomeAccount = await getAccountByCode('4300'); // Other Income
  const expenseAccount = await getAccountByCode('5600'); // Administrative Expenses

  if (!balanceAccount) throw new Error('Balance account not found');
  const offsetAccount = isDebit ? incomeAccount : expenseAccount;
  if (!offsetAccount) throw new Error('Offset account not found');

  const lines: JournalLineInput[] = isDebit
    ? [
        { glAccountId: balanceAccount.id, debit: amount, credit: 0,
          description: `Adjustment ${adj.adjustment_number}` },
        { glAccountId: offsetAccount.id, debit: 0, credit: amount,
          description: `Adjustment ${adj.adjustment_number}` },
      ]
    : [
        { glAccountId: offsetAccount.id, debit: amount, credit: 0,
          description: `Adjustment ${adj.adjustment_number}` },
        { glAccountId: balanceAccount.id, debit: 0, credit: amount,
          description: `Adjustment ${adj.adjustment_number}` },
      ];

  const je = await createJournalEntry({
    entryDate: String(adj.adjustment_date),
    description: `${isCustomer ? 'Customer' : 'Supplier'} adjustment ${adj.adjustment_number}`,
    source: 'auto_adjustment',
    sourceDocumentId: id,
    lines,
  }, userId);
  await postJournalEntry(je.id, userId);

  const updated = (await sql`
    UPDATE accounting_adjustments
    SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
        gl_journal_entry_id = ${je.id}::UUID
    WHERE id = ${id} RETURNING *
  `) as Row[];

  log.info('Approved adjustment', { id, journalEntryId: je.id }, 'accounting');
  return mapRow(updated[0]!);
}

export async function cancelAdjustment(id: string): Promise<void> {
  await sql`UPDATE accounting_adjustments SET status = 'cancelled' WHERE id = ${id} AND status = 'draft'`;
}

function mapRow(row: Row): AccountingAdjustment {
  return {
    id: String(row.id),
    adjustmentNumber: row.adjustment_number ? String(row.adjustment_number) : '',
    entityType: String(row.entity_type) as AccountingAdjustment['entityType'],
    entityId: String(row.entity_id),
    adjustmentType: String(row.adjustment_type) as AccountingAdjustment['adjustmentType'],
    amount: Number(row.amount),
    reason: String(row.reason),
    adjustmentDate: String(row.adjustment_date),
    status: String(row.status) as AccountingAdjustment['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
