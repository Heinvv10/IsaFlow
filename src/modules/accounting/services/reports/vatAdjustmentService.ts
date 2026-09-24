/**
 * VAT Adjustment Service
 * Phase 1 Sage Alignment: Manual VAT corrections with GL posting
 */

import { sql, withSavepoint } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { isLockContention } from '../core/lockContention';
import type { VATAdjustment, VATAdjustmentCreateInput } from '../../types/gl.types';
import type { JournalLineInput } from '../../types/gl.types';
type Row = DbRow;


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
  const safeUserId = await resolveUserUuid(userId);
  const rows = (await sql`
    INSERT INTO vat_adjustments (
      company_id, adjustment_date, vat_period, adjustment_type, amount, reason, created_by
    ) VALUES (
      ${companyId}, ${input.adjustmentDate}, ${input.vatPeriod || null},
      ${input.adjustmentType}, ${input.amount}, ${input.reason}, ${safeUserId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created VAT adjustment', { id: rows[0]?.id }, 'accounting');
  return mapRow(rows[0]!);
}

/**
 * Why an approval was refused. Every refusal is raised before the first write,
 * so the route may answer it 4xx: `withAuth` COMMITs a 4xx, and here there is
 * nothing to commit.
 */
export class VatAdjustmentRefusal extends Error {
  readonly code = 'VAT_ADJUSTMENT_REFUSED';
  constructor(readonly kind: 'not_found' | 'not_draft' | 'contended', message: string) {
    super(message);
    this.name = 'VatAdjustmentRefusal';
  }
}

/**
 * Run one statement on the adjustment row under a bounded lock wait (5s), reset on
 * success only — after a timeout the tx is aborted and a reset would mask the error.
 * Contention (55P03 / 40P01) becomes the retryable `contended` refusal; it aborts the
 * request transaction, so the 409 commits nothing.
 */
async function underBoundedLock<T>(statement: () => Promise<T>): Promise<T> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error('VAT adjustment writes require a request transaction (withAuth / als.run); outside one a row lock holds nothing.');
  }
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const out = await statement();
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return out;
  } catch (err) {
    if (isLockContention(err)) {
      throw new VatAdjustmentRefusal('contended', 'This VAT adjustment is being changed by another request — retry in a moment.');
    }
    throw err;
  }
}

/**
 * The adjustment row under `FOR UPDATE` for the rest of the request. This is the
 * guard (R-051): the status read and the journal it decides on used to be
 * unlocked, so two approvals both read 'draft' and both posted. Holding the row
 * makes the second wait for the first to commit, then read 'approved' and
 * refuse. `cancelVATAdjustment` waits on the same row, so a cancel cannot slip in.
 */
async function lockAdjustmentForUpdate(companyId: string, id: string): Promise<Row | null> {
  const rows = await underBoundedLock(async () => (await sql`
    SELECT * FROM vat_adjustments WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`) as Row[]);
  return rows[0] ?? null;
}

export async function approveVATAdjustment(companyId: string,
  id: string,
  userId: string
): Promise<VATAdjustment> {
  const safeUserId = await resolveUserUuid(userId);
  const va = await lockAdjustmentForUpdate(companyId, id);
  if (!va) throw new VatAdjustmentRefusal('not_found', 'VAT adjustment not found');
  if (va.status !== 'draft') throw new VatAdjustmentRefusal('not_draft', 'VAT adjustment is not in draft status');

  const amount = Number(va.amount);
  const isInput = va.adjustment_type === 'input';

  // GL: Input → DR VAT Input, CR Expense
  //     Output → DR Expense, CR VAT Output
  const vatAccount = isInput
    ? await getSystemAccount('vat_input', companyId)
    : await getSystemAccount('vat_output', companyId);
  const expenseAccount = await getSystemAccount('admin_expense', companyId);

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

  // adjustment_date comes back from pg as a Date object; String(Date) yields a
  // locale-formatted string Postgres rejects when inserted into entry_date.
  // fmtDate uses local getters matching how pg constructs DATE columns (a
  // UTC-based slice would silently roll the date back a day on this UTC+2
  // server) and also handles the string shape.
  const entryDate = fmtDate(va.adjustment_date);
  if (!entryDate) throw new Error(`VAT adjustment ${id} has an invalid adjustment_date value`);

  // No sourceDocumentId: gl_journal_entries.source_document_id has an FK to
  // captured_documents(id) only (migration 409); a VAT adjustment's own id
  // would violate it. The adjustment <-> journal entry link is instead
  // persisted below via vat_adjustments.gl_journal_entry_id.
  // All or nothing. postJournalEntry refuses some journals only AFTER the draft
  // exists (a closed fiscal period, an inactive account), and the route answers
  // that refusal 400, which withAuth COMMITs — the draft used to stay behind.
  // The savepoint rolls the draft back with the refusal.
  return withSavepoint('vat_adjustment_approve', async () => {
    const je = await createJournalEntry(companyId, {
      entryDate,
      description: `VAT adjustment ${va.adjustment_number}`,
      source: 'auto_vat_adjustment',
      lines,
    }, safeUserId);
    await postJournalEntry(companyId, je.id, safeUserId);

    const updated = (await sql`
      UPDATE vat_adjustments
      SET status = 'approved', approved_by = ${safeUserId}::UUID, approved_at = NOW(),
          gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId} RETURNING *
    `) as Row[];

    log.info('Approved VAT adjustment', { id, journalEntryId: je.id }, 'accounting');
    return mapRow(updated[0]!);
  });
}

export async function cancelVATAdjustment(companyId: string, id: string): Promise<void> {
  // Bounded like approve: it waits on the row an approval holds for its whole post.
  const result = await underBoundedLock(async () => (await sql`
    UPDATE vat_adjustments SET status = 'cancelled'
    WHERE id = ${id} AND company_id = ${companyId} AND status = 'draft' RETURNING id`) as DbRow[]);
  if (result.length > 0) return;
  const [row] = (await sql`SELECT status FROM vat_adjustments WHERE id = ${id} AND company_id = ${companyId}`) as Row[];
  if (!row) throw new VatAdjustmentRefusal('not_found', 'VAT adjustment not found');
  throw new VatAdjustmentRefusal('not_draft', `VAT adjustment is ${String(row.status)}, not draft`);
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
