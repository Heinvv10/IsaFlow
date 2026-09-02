/**
 * MCP write tools: logging and submitting practice time.
 *
 * These are the billable ones. A time entry is not a ledger posting — nothing
 * reaches gl_journal_entries — but the row carries an applied_rate and a
 * line_total, lands in WIP, and is what a client is ultimately invoiced for.
 * So the guards here are deliberately tighter than the REST route's:
 *
 *   - `origin` is forced to 'assisted', never taken from args. It is the only
 *     way to tell agent-booked hours from hours a person typed, and an agent
 *     that could claim 'manual' would erase that distinction in every audit.
 *   - Both tools are scoped to the TOKEN'S OWN user. createPracticeEntry
 *     already takes ctx.userId, but submitPracticeEntries is company-scoped
 *     only, so an agent could otherwise submit a colleague's drafts for
 *     approval. submit_time_entries passes ctx.userId to close that.
 *   - `dry_run` runs every guard the live path runs and writes nothing, and
 *     returns `wroteNothing` so the registry leaves the idempotency key free
 *     for the real call that follows.
 */
import type { McpTool } from '../types';
import {
  createPracticeEntry,
  getEntryStatusesByIds,
  validateClientCategoryWorkItem,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { submitPracticeEntries } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import { resolveRate } from '@/modules/accounting/services/practice/practiceStaffRateService';
import { UUID_RE } from '@/lib/validation';
import { roundHours, lineTotalFor } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';
import {
  guardCastableArgs,
  guardUuidList,
  ok,
  safeErrorText,
  strArg,
  toolError,
} from './toolHelpers';

const MAX_SUBMIT_IDS = 200;

/**
 * How far back an agent may book time without saying so explicitly.
 *
 * Backdating itself is legitimate and must stay possible — people log Monday's
 * work on Friday, and the UI allows any past date. The floor is the first day
 * of the PREVIOUS calendar month: a practice invoices monthly, so "this month
 * and last month" is the catch-up window, and anything older lands in a period
 * that has been billed and reported on.
 *
 * A rolling day count is the wrong shape here. Ninety days on 2 September still
 * admits early July — a month long since invoiced — while on 1 March it would
 * refuse a perfectly ordinary catch-up into January. Periods are what the
 * downstream code actually keys on, so the bound is a period too.
 *
 * What this protects is NOT the invoice. `getWipByClient` only picks up
 * `approved` rows, and nothing an agent can call reaches `approved` — the
 * draft → submitted → approved path needs a human, and `markEntriesBilled`
 * permanently excludes anything already billed. The exposure is reporting:
 * every figure in practiceReportsService windows on `te.entry_date`, so a row
 * existing in `draft` is already enough to restate a closed month's utilisation
 * and recovery, with no approval anywhere in the loop. Rates are date-effective
 * too, so a backdated entry silently carries that period's rate.
 *
 * A person picking a date months back is making a visible decision; an agent
 * acting on a prompt is not. So this is a speed bump, not a wall:
 * `allow_backdating` lets a caller that means it through, and the refusal names
 * both the argument and the accepted floor so a legitimate catch-up is one
 * retry away, never a dead end.
 */
export function backdateFloor(todayIso: string): string {
  const [y, m] = todayIso.split('-').map(Number) as [number, number, number];
  // First day of the previous calendar month; January rolls to December.
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export const logTimeEntryTool: McpTool = {
  name: 'log_time_entry',
  description:
    'Log a draft time entry against a practice client, job category and work item. All three ids are required and must be active and consistent — the work item must belong to the category. Resolve them with list_practice_clients / list_job_categories / list_work_items first. Without allow_backdating, entry_date must fall in the current or previous calendar month. The entry is created as a DRAFT and is booked to the calling user; submit_time_entries moves it into the approval flow. The rate is resolved server-side from the staff/client rate table and is not accepted as an argument. Use dry_run to validate without writing.',
  scope: 'write:practice',
  write: true,
  // The entry belongs to the user who logged it, so the key is namespaced by
  // caller: two staff on one engagement picking the same natural key must not
  // have the second silently served the first's entry.
  perUserIdempotency: true,
  inputSchema: {
    type: 'object',
    properties: {
      entry_date: { type: 'string', description: 'ISO date (YYYY-MM-DD). Cannot be in the future.' },
      hours: { type: 'number', description: 'Greater than 0 and at most 24.' },
      practice_client_id: { type: 'string' },
      job_category_id: { type: 'string' },
      work_item_id: { type: 'string', description: 'Must belong to job_category_id.' },
      task_description: { type: 'string', description: 'What was actually done. Max 500 characters.' },
      notes: { type: 'string' },
      billable: { type: 'boolean', description: 'Defaults to true.' },
      allow_backdating: {
        type: 'boolean',
        description: 'Required to book into any month before the previous calendar month. Such a period has usually been invoiced and reported on; the entry would restate those reports, and it carries the rate effective on that date rather than today\'s.',
      },
      dry_run: { type: 'boolean', description: 'Validate everything and report the rate that would apply, without writing.' },
      idempotency_key: { type: 'string' },
    },
    required: [
      'entry_date', 'hours', 'practice_client_id', 'job_category_id',
      'work_item_id', 'task_description', 'idempotency_key',
    ],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, {
      uuid: ['practice_client_id', 'job_category_id', 'work_item_id'],
      date: ['entry_date'],
    });
    if (guard) return guard;

    const entryDate = strArg(args, 'entry_date');
    const practiceClientId = strArg(args, 'practice_client_id');
    const jobCategoryId = strArg(args, 'job_category_id');
    const workItemId = strArg(args, 'work_item_id');
    const taskDescription = strArg(args, 'task_description');
    if (!entryDate) return toolError('entry_date is required');
    if (!practiceClientId) return toolError('practice_client_id is required');
    if (!jobCategoryId) return toolError('job_category_id is required');
    if (!workItemId) return toolError('work_item_id is required');
    if (!taskDescription) return toolError('task_description is required');
    if (taskDescription.length > 500) return toolError('task_description must be 500 characters or fewer');

    // Range-check the value AS STORED. `hours` is NUMERIC(6,2), so 0.004 is
    // > 0 here but 0.00 in the column; the service applies the same rule, and
    // the tool has to agree or a dry run would pass what the write refuses.
    const hours = roundHours(Number(args.hours));
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return toolError('hours must be a number greater than 0 and at most 24 (stored to 2 decimals, so anything under 0.005 rounds to zero and is refused)');
    }

    const today = new Date().toISOString().slice(0, 10);
    if (entryDate > today) return toolError('entry_date cannot be in the future');

    const floor = backdateFloor(today);
    if (entryDate < floor && args.allow_backdating !== true) {
      return toolError(
        `entry_date ${entryDate} is before ${floor}. Without allow_backdating this tool books only into the ` +
        `current or previous month: an older period has usually been invoiced and reported on, every practice ` +
        `report windows on entry_date so the row would restate it, and the rate applied is the one effective ` +
        `on that date. Re-send with allow_backdating: true if that is intended.`,
      );
    }

    const billable = args.billable === undefined ? true : args.billable === true;

    // dry_run parity: every guard the live path runs, run here too. A dry run
    // that skips the ownership/active checks would greenlight a call the real
    // one then refuses.
    if (args.dry_run === true) {
      try {
        await validateClientCategoryWorkItem(
          ctx.companyId, practiceClientId, jobCategoryId, workItemId,
        );
      } catch (err) {
        return toolError(safeErrorText(err, 'The client, category or work item is not usable.'));
      }
      const rate = await resolveRate(ctx.companyId, ctx.userId, practiceClientId, entryDate);
      return {
        ...ok({
          dry_run: true,
          would_create: {
            entry_date: entryDate, hours, billable,
            applied_rate: rate,
            line_total: lineTotalFor(hours, rate),
          },
          note: rate == null
            ? 'No staff rate is configured for this user and client on this date; the entry would be created with no rate and no line total.'
            : 'Validation passed. Re-send without dry_run, reusing this idempotency_key, to write it.',
        }),
        wroteNothing: true,
      };
    }

    try {
      const entry = await createPracticeEntry(ctx.companyId, ctx.userId, {
        entryDate,
        hours,
        practiceClientId,
        jobCategoryId,
        workItemId,
        taskDescription,
        notes: strArg(args, 'notes') ?? null,
        billable,
        // Never from args — see the file header.
        origin: 'assisted',
      });
      return ok({
        id: entry.id,
        entry_date: entry.entryDate,
        hours: entry.hours,
        status: entry.status,
        billable: entry.billable,
        applied_rate: entry.appliedRate,
        line_total: entry.lineTotal,
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Could not log the time entry.'));
    }
  },
};

export const submitTimeEntriesTool: McpTool = {
  name: 'submit_time_entries',
  description:
    'Submit draft time entries for approval. Only the calling user\'s own DRAFT entries are affected — ids belonging to another user, or already past draft, are skipped rather than refused, and the reply reports which. This moves hours into the approval flow that feeds WIP and client invoicing.',
  scope: 'write:practice',
  write: true,
  // Acts only on the caller's own entries — same reasoning as log_time_entry.
  perUserIdempotency: true,
  inputSchema: {
    type: 'object',
    properties: {
      entry_ids: {
        type: 'array',
        items: { type: 'string' },
        description: `Time entry UUIDs from list_time_entries. Max ${MAX_SUBMIT_IDS}.`,
      },
      dry_run: { type: 'boolean', description: 'Report which ids would be submitted, without writing.' },
      idempotency_key: { type: 'string' },
    },
    required: ['entry_ids', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const raw = args.entry_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return toolError('entry_ids is required and must be a non-empty array');
    }
    if (raw.length > MAX_SUBMIT_IDS) {
      return toolError(`entry_ids accepts at most ${MAX_SUBMIT_IDS} ids per call`);
    }
    const listGuard = guardUuidList(raw, (i) => `entry_ids[${i}]`);
    if (listGuard) return listGuard;

    const ids = [...new Set(raw as string[])].filter((id) => UUID_RE.test(id));

    // Resolve what is actually submittable BEFORE writing, so the reply can
    // name the skipped ids instead of just returning a count that silently
    // disagrees with what the agent asked for.
    //
    // Looked up BY ID, not by listing the user's entries and filtering: a staff
    // member with years of history would otherwise have their whole timesheet
    // pulled into memory on every call, dry runs included, to check at most 200
    // ids. The lookup carries the same company + user scope the UPDATE does.
    const statuses = await getEntryStatusesByIds(ctx.companyId, ids, ctx.userId);
    const submittableSet = new Set(ids.filter((id) => statuses.get(id) === 'draft'));
    const submittable = [...submittableSet];
    const skipped = ids
      .filter((id) => !submittableSet.has(id))
      .map((id) => ({
        id,
        reason: statuses.has(id)
          ? `status is '${statuses.get(id)!}', not 'draft'`
          : 'not found, or not this user\'s entry',
      }));

    if (args.dry_run === true) {
      return {
        ...ok({ dry_run: true, would_submit: submittable, skipped }),
        wroteNothing: true,
      };
    }

    if (submittable.length === 0) {
      return toolError(
        `None of the supplied ids are draft entries belonging to this user. ${JSON.stringify(skipped)}`,
      );
    }

    try {
      // Scoped to ctx.userId: submitPracticeEntries is otherwise company-wide,
      // which would let an agent push a colleague's drafts into approval.
      const count = await submitPracticeEntries(ctx.companyId, submittable, ctx.userId);
      return ok({ submitted: count, submitted_ids: submittable, skipped });
    } catch (err) {
      return toolError(safeErrorText(err, 'Could not submit the time entries.'));
    }
  },
};
