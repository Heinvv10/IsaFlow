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
  listPracticeEntries,
  validateClientCategoryWorkItem,
} from '@/modules/accounting/services/practice/practiceTimeEntryService';
import { submitPracticeEntries } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import { resolveRate } from '@/modules/accounting/services/practice/practiceStaffRateService';
import { UUID_RE } from '@/lib/validation';
import {
  guardCastableArgs,
  guardUuidList,
  ok,
  safeErrorText,
  strArg,
  toolError,
} from './toolHelpers';

const MAX_SUBMIT_IDS = 200;

export const logTimeEntryTool: McpTool = {
  name: 'log_time_entry',
  description:
    'Log a draft time entry against a practice client, job category and work item. All three ids are required and must be active and consistent — the work item must belong to the category. Resolve them with list_practice_clients / list_job_categories / list_work_items first. The entry is created as a DRAFT and is booked to the calling user; submit_time_entries moves it into the approval flow. The rate is resolved server-side from the staff/client rate table and is not accepted as an argument. Use dry_run to validate without writing.',
  scope: 'write:practice',
  write: true,
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

    const hours = Number(args.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return toolError('hours must be a number greater than 0 and at most 24');
    }

    const today = new Date().toISOString().slice(0, 10);
    if (entryDate > today) return toolError('entry_date cannot be in the future');

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
            line_total: rate == null ? null : Math.round(hours * rate * 100) / 100,
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
    const { entries } = await listPracticeEntries(ctx.companyId, { userId: ctx.userId });
    const mine = new Map(entries.map((e) => [e.id, e]));
    const submittable = ids.filter((id) => mine.get(id)?.status === 'draft');
    const skipped = ids
      .filter((id) => !submittable.includes(id))
      .map((id) => ({
        id,
        reason: mine.has(id)
          ? `status is '${mine.get(id)!.status}', not 'draft'`
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
