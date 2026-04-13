/**
 * Accounting Adjustment Service
 * Phase 1 Sage Alignment: Customer & supplier balance adjustments
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import type { AccountingAdjustment, AdjustmentCreateInput } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';

type Row = DbRow;


export async function getAdjustments(companyId: string, filters?: {
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
      SELECT a.*, c.name AS customer_name, s.name AS supplier_name
      FROM accounting_adjustments a
      LEFT JOIN customers c ON a.entity_type = 'customer' AND c.id = a.entity_id
      LEFT JOIN suppliers s ON a.entity_type = 'supplier' AND s.id = a.entity_id
      WHERE a.company_id = ${companyId} AND a.entity_type = ${filters.entityType}
      ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM accounting_adjustments
      WHERE company_id = ${companyId} AND entity_type = ${filters.entityType}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT a.*, c.name AS customer_name, s.name AS supplier_name
      FROM accounting_adjustments a
      LEFT JOIN customers c ON a.entity_type = 'customer' AND c.id = a.entity_id
      LEFT JOIN suppliers s ON a.entity_type = 'supplier' AND s.id = a.entity_id
      WHERE a.company_id = ${companyId}
      ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM accounting_adjustments WHERE company_id = ${companyId}`) as Row[];
  }

  const items: AccountingAdjustment[] = rows.map(row => {
    const mapped = mapRow(row);
    mapped.entityName = row.entity_type === 'customer'
      ? (row.customer_name ? String(row.customer_name) : 'Unknown')
      : (row.supplier_name ? String(row.supplier_name) : 'Unknown');
    return mapped;
  });

  return { items, total: Number(countRows[0]?.cnt || 0) };
}

export async function createAdjustment(companyId: string,
  input: AdjustmentCreateInput,
  userId: string
): Promise<AccountingAdjustment> {
  const rows = (await sql`
    INSERT INTO accounting_adjustments (
      company_id, entity_type, entity_id, adjustment_type, amount, reason,
      adjustment_date, created_by
    ) VALUES (
      ${companyId}, ${input.entityType}, ${input.entityId}::UUID, ${input.adjustmentType},
      ${input.amount}, ${input.reason},
      ${input.adjustmentDate || new Date().toISOString().split('T')[0]},
      ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created adjustment', { id: rows[0]?.id, type: input.entityType }, 'accounting');
  return mapRow(rows[0]!);
}

export async function approveAdjustment(companyId: string, id: string, userId: string): Promise<AccountingAdjustment> {
  const adjRows = (await sql`SELECT * FROM accounting_adjustments WHERE id = ${id} AND company_id = ${companyId}`) as Row[];
  if (!adjRows[0]) throw new Error('Adjustment not found');
  if (adjRows[0].status !== 'draft') throw new Error('Adjustment is not in draft status');

  const adj = adjRows[0];
  const amount = Number(adj.amount);
  const isCustomer = adj.entity_type === 'customer';
  const isDebit = adj.adjustment_type === 'debit';

  // GL accounts
  const balanceAccount = isCustomer
    ? await getSystemAccount('receivable', companyId)
    : await getSystemAccount('payable', companyId);
  const offsetAccount = isDebit
    ? await getSystemAccount('other_income', companyId)
    : await getSystemAccount('admin_expense', companyId);

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

  const je = await createJournalEntry(companyId, {
    entryDate: String(adj.adjustment_date),
    description: `${isCustomer ? 'Customer' : 'Supplier'} adjustment ${adj.adjustment_number}`,
    source: 'auto_adjustment',
    sourceDocumentId: id,
    lines,
  }, userId);
  await postJournalEntry(companyId, je.id, userId);

  // Wrap the final status update atomically — if this fails the JE exists but the
  // adjustment stays in draft, which is recoverable, rather than silently half-applied.
  const updated = await withTransaction(async (tx) => {
    return (await tx`
      UPDATE accounting_adjustments
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
          gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId} RETURNING *
    `) as Row[];
  });

  log.info('Approved adjustment', { id, journalEntryId: je.id }, 'accounting');
  return mapRow(updated[0]!);
}

export async function cancelAdjustment(companyId: string, id: string): Promise<void> {
  await sql`UPDATE accounting_adjustments SET status = 'cancelled' WHERE id = ${id} AND company_id = ${companyId} AND status = 'draft'`;
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
