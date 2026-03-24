/**
 * Recurring Journal Service
 * Phase 1 Sage Alignment: Scheduled automated journal entries
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import type { RecurringJournal, RecurringJournalCreateInput, JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export async function getRecurringJournals(filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: RecurringJournal[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: Row[];
  let countRows: Row[];

  if (filters?.status) {
    rows = (await sql`
      SELECT * FROM recurring_journals WHERE status = ${filters.status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM recurring_journals WHERE status = ${filters.status}
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM recurring_journals
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as Row[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM recurring_journals`) as Row[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function createRecurringJournal(
  input: RecurringJournalCreateInput,
  userId: string
): Promise<RecurringJournal> {
  // Validate lines balance
  const totalDebit = input.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = input.lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Journal lines do not balance: DR ${totalDebit.toFixed(2)} vs CR ${totalCredit.toFixed(2)}`);
  }

  const rows = (await sql`
    INSERT INTO recurring_journals (
      template_name, description, frequency, next_run_date,
      end_date, lines, total_amount, created_by
    ) VALUES (
      ${input.templateName}, ${input.description || null}, ${input.frequency},
      ${input.nextRunDate}, ${input.endDate || null},
      ${JSON.stringify(input.lines)}::JSONB, ${totalDebit}, ${userId}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Created recurring journal', { id: rows[0]?.id }, 'accounting');
  return mapRow(rows[0]!);
}

export async function updateRecurringJournalStatus(
  id: string,
  status: 'paused' | 'active' | 'cancelled'
): Promise<void> {
  await sql`UPDATE recurring_journals SET status = ${status} WHERE id = ${id}`;
  log.info('Updated recurring journal status', { id, status }, 'accounting');
}

export async function generateJournalFromRecurring(
  id: string,
  userId: string
): Promise<string> {
  const rows = (await sql`SELECT * FROM recurring_journals WHERE id = ${id}`) as Row[];
  if (!rows[0]) throw new Error('Recurring journal not found');
  const rj = rows[0];
  if (rj.status !== 'active') throw new Error('Recurring journal is not active');

  const lines: JournalLineInput[] = Array.isArray(rj.lines) ? rj.lines : JSON.parse(rj.lines || '[]');

  const je = await createJournalEntry({
    entryDate: new Date().toISOString().split('T')[0]!,
    description: rj.description || rj.template_name,
    source: 'auto_recurring',
    lines,
  }, userId);
  await postJournalEntry(je.id, userId);

  // Advance next run date
  const nextDate = advanceDate(String(rj.next_run_date), String(rj.frequency));
  const endDate = rj.end_date ? String(rj.end_date) : null;
  const newStatus = endDate && nextDate > endDate ? 'completed' : 'active';

  await sql`
    UPDATE recurring_journals
    SET last_run_date = CURRENT_DATE, next_run_date = ${nextDate}::DATE,
        run_count = run_count + 1, status = ${newStatus}
    WHERE id = ${id}
  `;

  log.info('Generated journal from recurring', { recurringId: id, journalId: je.id }, 'accounting');
  return je.id;
}

function advanceDate(dateStr: string, frequency: string): string {
  const d = new Date(dateStr);
  switch (frequency) {
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'annually': d.setFullYear(d.getFullYear() + 1); break;
  }
  return d.toISOString().split('T')[0]!;
}

function mapRow(row: Row): RecurringJournal {
  return {
    id: String(row.id),
    templateName: String(row.template_name),
    description: row.description ? String(row.description) : undefined,
    frequency: String(row.frequency) as RecurringJournal['frequency'],
    nextRunDate: String(row.next_run_date),
    endDate: row.end_date ? String(row.end_date) : undefined,
    lastRunDate: row.last_run_date ? String(row.last_run_date) : undefined,
    runCount: Number(row.run_count),
    status: String(row.status) as RecurringJournal['status'],
    lines: Array.isArray(row.lines) ? row.lines : JSON.parse(row.lines || '[]'),
    totalAmount: Number(row.total_amount),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
