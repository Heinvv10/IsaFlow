/**
 * Recurring Journal Service
 * Phase 1 Sage Alignment: Scheduled automated journal entries
 */

import { sql, withTransaction } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getPeriodStatusForDate } from './periodStatusService';
import type { RecurringJournal, RecurringJournalCreateInput, JournalLineInput } from '../../types/gl.types';
import type { DbRow } from '@/types/db';

/**
 * A caller fault on a recurring-journal action — the template is missing, not
 * active, not due yet, or its period is not postable. The route answers these
 * with a 400; anything NOT of this class is a genuine failure that must reach
 * `withErrorHandler` as a 500 so `withAuth` ROLLBACKs the request transaction
 * (a 400 COMMITs, which is what let a half-written journal survive a refusal).
 */
export class RecurringJournalRequestError extends Error {
  readonly code = 'RECURRING_JOURNAL_REQUEST';
  constructor(message: string) {
    super(message);
    this.name = 'RecurringJournalRequestError';
  }
}

/** Postgres `lock_not_available` — the 5s `lock_timeout` elapsed on the template row. */
const LOCK_NOT_AVAILABLE = '55P03';


export async function getRecurringJournals(companyId: string, filters?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: RecurringJournal[]; total: number }> {
  const limit = filters?.limit || 50;
  const offset = filters?.offset || 0;
  let rows: DbRow[];
  let countRows: DbRow[];

  if (filters?.status) {
    rows = (await sql`
      SELECT * FROM recurring_journals WHERE company_id = ${companyId} AND status = ${filters.status}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as DbRow[];
    countRows = (await sql`
      SELECT COUNT(*) AS cnt FROM recurring_journals WHERE company_id = ${companyId} AND status = ${filters.status}
    `) as DbRow[];
  } else {
    rows = (await sql`
      SELECT * FROM recurring_journals WHERE company_id = ${companyId}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as DbRow[];
    countRows = (await sql`SELECT COUNT(*) AS cnt FROM recurring_journals WHERE company_id = ${companyId}`) as DbRow[];
  }

  return { items: rows.map(mapRow), total: Number(countRows[0]?.cnt || 0) };
}

export async function createRecurringJournal(companyId: string, 
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
      company_id, template_name, description, frequency, next_run_date,
      end_date, lines, total_amount, created_by
    ) VALUES (
      ${companyId}, ${input.templateName}, ${input.description || null}, ${input.frequency},
      ${input.nextRunDate}, ${input.endDate || null},
      ${JSON.stringify(input.lines)}::JSONB, ${totalDebit}, ${userId}::UUID
    ) RETURNING *
  `) as DbRow[];

  log.info('Created recurring journal', { id: rows[0]?.id }, 'accounting');
  return mapRow(rows[0]!);
}

export async function updateRecurringJournalStatus(companyId: string,
  id: string,
  status: 'paused' | 'active' | 'cancelled'
): Promise<void> {
  const result = (await sql`UPDATE recurring_journals SET status = ${status} WHERE id = ${id} AND company_id = ${companyId} RETURNING id`) as DbRow[];
  if (result.length === 0) throw new RecurringJournalRequestError(`Recurring journal not found: ${id}`);
  log.info('Updated recurring journal status', { id, status }, 'accounting');
}

/**
 * Read the template and hold a row lock on it for the rest of the request.
 *
 * The lock only bites inside a request transaction (`withAuth` / `als.run`);
 * outside one each statement is its own transaction and `FOR UPDATE` releases
 * immediately. That is tolerable HERE — and only here — because the lock is not
 * what makes generation idempotent: the status-and-date-predicated claim UPDATE
 * below is, and that is atomic on its own connection either way. The lock
 * simply lets a concurrent request block rather than lose the claim and be told
 * the run was already taken.
 */
async function readTemplateForUpdate(companyId: string, id: string): Promise<DbRow | undefined> {
  const client = als.getStore()?.client;
  if (client) {
    // Re-issued every call, never memoised: `SET LOCAL` is subtransaction-aware
    // and a `ROLLBACK TO SAVEPOINT` restores it to 0 — no timeout at all.
    assertTxUsable();
    await client.query("SET LOCAL lock_timeout = '5s'");
  }
  try {
    const rows = (await sql`
      SELECT * FROM recurring_journals
      WHERE id = ${id} AND company_id = ${companyId}
      FOR UPDATE
    `) as DbRow[];
    return rows[0];
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new RecurringJournalRequestError(
        `Recurring journal ${id} is being generated by another request — retry in a moment.`,
      );
    }
    throw err;
  }
}

/**
 * Post one journal for the run that is due on the template's `next_run_date`.
 *
 * Three guards the original had none of, in this order — every one of them
 * BEFORE the first write, so a refusal leaves nothing behind for `withAuth` to
 * commit alongside the 400:
 *
 * 1. **Due date.** `next_run_date` was read only to compute the next one; a
 *    template scheduled for next year posted on demand.
 * 2. **Period.** `postJournalEntry` raises `ClosedFiscalPeriodError` only after
 *    `createJournalEntry` has INSERTed the draft, so the refusal used to arrive
 *    one write too late and the draft survived the 400.
 * 3. **The claim.** `UPDATE ... WHERE status = 'active' AND next_run_date = <due>`
 *    is the idempotency key this table never had: exactly one caller can move a
 *    given run date off 'active', so a repeat (a double-click, a retry) finds
 *    the schedule already advanced and is refused as not due. The claim and the
 *    posting share one transaction, so a posting failure un-advances the
 *    schedule instead of silently skipping the period.
 *
 * The journal is dated at `next_run_date`, not today: a run caught up a week
 * late belongs in the period it was scheduled for.
 */
export async function generateJournalFromRecurring(companyId: string, 
  id: string,
  userId: string
): Promise<string> {
  const rj = await readTemplateForUpdate(companyId, id);
  if (!rj) throw new RecurringJournalRequestError('Recurring journal not found');
  if (rj.status !== 'active') throw new RecurringJournalRequestError('Recurring journal is not active');

  const dueDate = String(rj.next_run_date);
  const todayRows = (await sql`SELECT CURRENT_DATE::TEXT AS today`) as DbRow[];
  const today = String(todayRows[0]!.today);
  if (dueDate > today) {
    throw new RecurringJournalRequestError(
      `Recurring journal is not due until ${dueDate}. Change the next run date to generate it earlier.`,
    );
  }

  const period = await getPeriodStatusForDate(companyId, dueDate);
  if (period === 'no_period') {
    throw new RecurringJournalRequestError(
      `No fiscal period covers ${dueDate}, the date this run is scheduled for. Create the fiscal `
      + 'year first — posting outside every period would leave the journal invisible to the trial '
      + 'balance, the VAT201 and the AFS.',
    );
  }
  if (period !== 'open') {
    throw new RecurringJournalRequestError(
      `The fiscal period covering ${dueDate}, the date this run is scheduled for, is ${period}. `
      + 'Re-open it before generating into it.',
    );
  }

  const lines: JournalLineInput[] = Array.isArray(rj.lines) ? rj.lines as JournalLineInput[] : JSON.parse(typeof rj.lines === 'string' ? rj.lines : '[]');
  const nextDate = advanceDate(dueDate, String(rj.frequency));
  const endDate = rj.end_date ? String(rj.end_date) : null;
  const newStatus = endDate && nextDate > endDate ? 'completed' : 'active';

  return withTransaction(async (tx) => {
    const claimed = (await tx`
      UPDATE recurring_journals
      SET last_run_date = CURRENT_DATE, next_run_date = ${nextDate}::DATE,
          run_count = run_count + 1, status = ${newStatus}
      WHERE id = ${id} AND company_id = ${companyId}
        AND status = 'active' AND next_run_date = ${dueDate}::DATE
      RETURNING id
    `) as DbRow[];
    if (claimed.length === 0) {
      throw new RecurringJournalRequestError(
        `The ${dueDate} run of this recurring journal has already been generated.`,
      );
    }

    const je = await createJournalEntry(companyId, {
      entryDate: dueDate,
      description: rj.description ? String(rj.description) : String(rj.template_name),
      source: 'auto_recurring',
      lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);

    log.info('Generated journal from recurring', { recurringId: id, journalId: je.id, runDate: dueDate }, 'accounting');
    return je.id;
  });
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

function mapRow(row: DbRow): RecurringJournal {
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
    lines: Array.isArray(row.lines) ? row.lines as JournalLineInput[] : JSON.parse(typeof row.lines === 'string' ? row.lines : '[]'),
    totalAmount: Number(row.total_amount),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
