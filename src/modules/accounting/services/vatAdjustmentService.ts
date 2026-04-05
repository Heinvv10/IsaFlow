/**
 * VAT Adjustment Service
 * Phase 1 Sage Alignment: Manual VAT corrections with GL posting
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getSystemAccount } from './systemAccountResolver';
import type { VATAdjustment, VATAdjustmentCreateInput } from '../types/gl.types';
import type { JournalLineInput } from '../types/gl.types';
type Row = Record<string, unknown>;


export async function getVATAdjustments(companyId: string, filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: VATAdjustment[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.status) {
    rows = (await sql`
      SELECT * FROM vat_adjustments
      WHERE company_id = ${companyId} AND status = ${filters.status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM vat_adjustments
      WHERE company_id = ${companyId} AND status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM vat_adjustments WHERE company_id = ${companyId}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM vat_adjustments WHERE company_id = ${companyId}`) as Row[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function createVATAdjustment(companyId: string, 
  input: VATAdjustmentCreateInput,
  userId: string
): Promise<VATAdjustment> {
  const rows = (await sql`
    INSERT INTO vat_adjustments (
      company_id, adjustment_date, vat_period, adjustment_type, amount, reason, created_by
    ) VALUES (
      ${companyId}, ${input.adjustmentDate}, ${input.vatPeriod || null},
      ${input.adjustmentType}, ${input.amount}, ${input.reason}, ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created VAT adjustment', { id: rows[0]?.id }, 'accounting');
  return mapRow(rows[0]!);
}

export async function approveVATAdjustment(companyId: string, 
  id: string,
  userId: string
): Promise<VATAdjustment> {
  const vaRows = (await sql`SELECT * FROM vat_adjustments WHERE id = ${id} AND company_id = ${companyId}`) as Row[];
  if (!vaRows[0]) throw new Error('VAT adjustment not found');
  if (vaRows[0].status !== 'draft') throw new Error('VAT adjustment is not in draft status');

  const va = vaRows[0];
  const amount = Number(va.amount);
  const isInput = va.adjustment_type === 'input';

  // GL: Input → DR VAT Input, CR Expense
  //     Output → DR Expense, CR VAT Output
  const vatAccount = isInput
    ? await getSystemAccount('vat_input')
    : await getSystemAccount('vat_output');
  const expenseAccount = await getSystemAccount('admin_expense');

  const lines: JournalLineInput[] = isInput
    ? [
        { glAccountId: vatAccount.id, debit: amount, credit: 0,
          description: `VAT input adjustment ${va.adjustment_number}` },
        { glAccountId: expenseAccount.id, debit: 0, credit: amount,
          description: `VAT input adjustment ${va.adjustment_number}` },
      ]
    : [
        { glAccountId: expenseAccount.id, debit: amount, credit: 0,
          description: `VAT output adjustment ${va.adjustment_number}` },
        { glAccountId: vatAccount.id, debit: 0, credit: amount,
          description: `VAT output adjustment ${va.adjustment_number}` },
      ];

  const je = await createJournalEntry('', {
    entryDate: String(va.adjustment_date),
    description: `VAT adjustment ${va.adjustment_number}`,
    source: 'auto_vat_adjustment',
    sourceDocumentId: id,
    lines,
  }, userId);
  await postJournalEntry(companyId, je.id, userId);

  const updated = (await sql`
    UPDATE vat_adjustments
    SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
        gl_journal_entry_id = ${je.id}::UUID
    WHERE id = ${id} AND company_id = ${companyId} RETURNING *
  `) as Row[];

  log.info('Approved VAT adjustment', { id, journalEntryId: je.id }, 'accounting');
  return mapRow(updated[0]!);
}

export async function cancelVATAdjustment(companyId: string, id: string): Promise<void> {
  await sql`UPDATE vat_adjustments SET status = 'cancelled' WHERE id = ${id} AND company_id = ${companyId} AND status = 'draft'`;
}

function mapRow(row: Row): VATAdjustment {
  return {
    id: String(row.id),
    adjustmentNumber: row.adjustment_number ? String(row.adjustment_number) : '',
    adjustmentDate: String(row.adjustment_date),
    vatPeriod: row.vat_period ? String(row.vat_period) : undefined,
    adjustmentType: String(row.adjustment_type) as VATAdjustment['adjustmentType'],
    amount: Number(row.amount),
    reason: String(row.reason),
    status: String(row.status) as VATAdjustment['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
