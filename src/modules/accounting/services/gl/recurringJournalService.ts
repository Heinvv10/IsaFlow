/**
 * Recurring Journal Service
 * Phase 1 Sage Alignment: Scheduled automated journal entries
 */

import { sql, withTransaction } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getPeriodStatusForDate } from './periodStatusService';
import {
  RecurringJournalRequestError,
  readTemplateForUpdate,
  businessToday,
  assertTemplateLinesPostable,
} from './recurringJournalGuards';
import { advanceDate } from './recurringSchedule';
import type { RecurringJournal, RecurringJournalCreateInput, JournalLineInput } from '../../types/gl.types';
import type { DbRow } from '@/types/db';

export { RecurringJournalRequestError, RecurringJournalLockTimeoutError } from './recurringJournalGuards';

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
 * Post one journal for the run that is due on the template's `next_run_date`.
 *
 * **Request-only.** Every guard below is worth having only if a failure after
 * the first write un-does the claim, and that holds only while the claim and
 * the posting run on ONE connection. Inside a request they do:
 * `withTransaction` joins the ALS client `withAuth` already opened. Outside one
 * it takes its own pooled connection for the claim while `createJournalEntry`
 * takes different ones that autocommit each statement, so a posting failure
 * would roll back the claim and leave an orphan draft entry committed in the
 * GL — worse than the defect this replaces. So it refuses to run there rather
 * than pretending. A cron or script path needs a `tx` threaded through
 * `createJournalEntry` / `postJournalEntry` first; that is a separate change.
 *
 * Four guards the original had none of, in this order — every one of them
 * BEFORE the first write, so a refusal leaves nothing behind for `withAuth` to
 * commit alongside the 400:
 *
 * 1. **Due date.** `next_run_date` was read only to compute the next one; a
 *    template scheduled for next year posted on demand.
 * 2. **Period.** `postJournalEntry` raises `ClosedFiscalPeriodError` only after
 *    `createJournalEntry` has INSERTed the draft, so the refusal used to arrive
 *    one write too late and the draft survived the 400.
 * 3. **The template's lines.** Same shape: a deactivated or deleted account, or
 *    an unbalanced template, is raised by `postJournalEntry` after the write.
 *    Read-checked here so the operator gets the account code in a 400 rather
 *    than a 500 reading "an unexpected error occurred".
 * 4. **The claim.** `UPDATE ... WHERE status = 'active' AND next_run_date = <due>`
 *    is the idempotency key this table never had: exactly one caller can move a
 *    given run date off 'active', so a repeat (a double-click, a retry) finds
 *    the schedule already advanced and is refused as not due.
 *
 * The journal is dated at `next_run_date`, not today: a run caught up a week
 * late belongs in the period it was scheduled for.
 */
export async function generateJournalFromRecurring(companyId: string, 
  id: string,
  userId: string
): Promise<string> {
  if (!als.getStore()?.client) {
    throw new Error(
      'generateJournalFromRecurring must run inside a request transaction (withAuth). Outside one '
      + 'the claim and the posting commit on separate connections, so a posting failure would leave '
      + 'an orphan journal entry committed while the schedule rolled back.',
    );
  }

  const rj = await readTemplateForUpdate(companyId, id);
  if (!rj) throw new RecurringJournalRequestError('Recurring journal not found');
  if (rj.status !== 'active') throw new RecurringJournalRequestError('Recurring journal is not active');

  const dueDate = String(rj.next_run_date);
  const today = await businessToday();
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
  await assertTemplateLinesPostable(companyId, lines);

  const nextDate = advanceDate(dueDate, String(rj.frequency));
  const endDate = rj.end_date ? String(rj.end_date) : null;
  const newStatus = endDate && nextDate > endDate ? 'completed' : 'active';

  return withTransaction(async (tx) => {
    const claimed = (await tx`
      UPDATE recurring_journals
      SET last_run_date = ${today}::DATE, next_run_date = ${nextDate}::DATE,
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
