/**
 * MCP write tools: recurring journal TEMPLATES (MCP brief step 7). create_recurring_journal stores a template
 * through the app's own createRecurringJournal; deactivate_recurring_journal pauses (or resumes) one through
 * updateRecurringJournalStatus. Generating from them is run_recurring_journals (writeRunRecurringJournals.ts).
 *
 * A template is checked by every rule a draft journal is (journalLineArgs, shared with create_draft_journal) AND by
 * the read guards a run applies before its first write (balanced, accounts active, no header-account line,
 * dimensions a new journal may carry), so a template that could never generate is refused when it is made rather
 * than on every run. An auto-posting template needs write:post, as an auto-posting bank rule does.
 */
import type { McpTool, McpToolContext } from '../types';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import {
  createRecurringJournal, getRecurringJournalById, updateRecurringJournalStatus,
} from '@/modules/accounting/services/gl/recurringJournalService';
import {
  RecurringJournalRequestError, assertTemplateLinesPostable,
} from '@/modules/accounting/services/gl/recurringJournalGuards';
import { assertNoHeaderAccountLines, isHeaderAccountRefusal } from '@/modules/accounting/services/gl/headerAccountGuard';
import { assertNewJournalDimensions } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { journalDayWindowError } from '@/modules/accounting/utils/journalDateWindow';
import type { JournalLineInput, RecurringFrequency } from '@/modules/accounting/types/gl.types';
import { JOURNAL_LINE_ITEM_SCHEMA, checkJournalLines } from './journalLineArgs';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const FREQUENCIES: readonly RecurringFrequency[] = ['weekly', 'monthly', 'quarterly', 'annually'];

const POSTS_NEED_WRITE_POST = 'A recurring journal that posts its journals automatically (auto_post: true) needs the '
  + '"Post to ledger" permission (write:post). Use auto_post: false to generate drafts, or reconnect with posting '
  + 'allowed. Nothing was changed.';

const UNDO = 'deactivate_recurring_journal with this id pauses it (it generates nothing while paused; enable: true '
  + 'resumes it). Cancelling it for good is on the Recurring Journals page.';

const mayPost = (ctx: McpToolContext) => ctx.scopes.includes('write:post');

/** The read guards a run applies before its first write, as a refusal text (null when the lines pass). */
async function runGuardRefusal(companyId: string, lines: JournalLineInput[]): Promise<string | null> {
  try {
    await assertTemplateLinesPostable(companyId, lines);
    await assertNoHeaderAccountLines(companyId, lines);
    await assertNewJournalDimensions(companyId, 'auto_recurring', lines);
    return null;
  } catch (err) {
    if (err instanceof RecurringJournalRequestError || isHeaderAccountRefusal(err) || isDimensionRefusal(err)) {
      return err.message;
    }
    throw err;
  }
}

export const createRecurringJournalTool: McpTool = {
  name: 'create_recurring_journal',
  description:
    'Create a recurring journal template: the same lines generated every week, month, quarter or year from start_date '
    + '(until end_date, if given). Lines are checked exactly as create_draft_journal checks them (balanced, accounts '
    + 'active and yours, cc1/cc2/bu, vat_type). auto_post (default false) makes each generated journal POST, which needs '
    + 'write:post; false generates drafts for a person to review. Nothing is generated now — use run_recurring_journals. '
    + 'Returns recurring_journal_id; deactivate_recurring_journal undoes it. dry_run: true checks it and writes nothing.',
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Template name; also the generated journals\' description unless description is set.' },
      description: { type: 'string', description: 'Description each generated journal carries.' },
      lines: { type: 'array', minItems: 2, items: JOURNAL_LINE_ITEM_SCHEMA },
      frequency: { type: 'string', enum: [...FREQUENCIES] },
      start_date: { type: 'string', format: 'date', description: 'Date of the first run, YYYY-MM-DD. Each journal is dated its run date.' },
      end_date: { type: 'string', format: 'date', description: 'Optional last date a run may fall on, YYYY-MM-DD.' },
      auto_post: { type: 'boolean', description: 'Default false (drafts). true posts each generated journal: needs write:post.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['name', 'lines', 'frequency', 'start_date', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const name = strArg(args, 'name');
    if (!name) return toolError('name is required');
    const frequency = strArg(args, 'frequency');
    if (!frequency || !(FREQUENCIES as readonly string[]).includes(frequency)) {
      return toolError(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
    }
    const startDate = strArg(args, 'start_date');
    if (!startDate) return toolError('start_date is required (YYYY-MM-DD)');
    const badDate = guardCastableArgs(args, { date: ['start_date', 'end_date'] });
    if (badDate) return badDate;
    const endDate = strArg(args, 'end_date');
    for (const day of [startDate, endDate]) {
      const outside = day ? journalDayWindowError(day) : null;
      if (outside) return toolError(outside);
    }
    if (endDate && endDate < startDate) return toolError('end_date must be on or after start_date');
    if (args.auto_post !== undefined && typeof args.auto_post !== 'boolean') return toolError('auto_post must be true or false');
    const autoPost = args.auto_post === true;
    if (autoPost && !mayPost(ctx)) return toolError(POSTS_NEED_WRITE_POST);

    const checked = await checkJournalLines(ctx, args.lines, 'create_recurring_journal');
    if (typeof checked === 'string') return toolError(checked);
    const { lines, warnings } = checked;
    const refusal = await runGuardRefusal(ctx.companyId, lines);
    if (refusal) return toolError(refusal);

    const description = strArg(args, 'description');
    const summary = {
      template_name: name, frequency, next_run_date: startDate, end_date: endDate ?? null, auto_post: autoPost,
      total_amount: Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100, line_count: lines.length,
      ...(warnings.length > 0 ? { dimension_warnings: warnings } : {}),
    };
    if (args.dry_run === true) return { ...ok({ dry_run: true, would_create: summary }), wroteNothing: true };

    const created = await createRecurringJournal(ctx.companyId, {
      templateName: name, description, frequency: frequency as RecurringFrequency, nextRunDate: startDate, endDate, lines, autoPost,
    }, ctx.userId);
    return ok({ recurring_journal_id: created.id, status: created.status, ...summary, undo: UNDO });
  },
};

export const deactivateRecurringJournalTool: McpTool = {
  name: 'deactivate_recurring_journal',
  description:
    'Pause a recurring journal template so run_recurring_journals generates nothing from it. The template is kept — '
    + 'pass enable: true to resume a paused one (resuming one that auto-posts needs write:post). A completed or '
    + 'cancelled template cannot be resumed. Journals already generated are not touched (reverse_journal_entry undoes '
    + 'a posted one). dry_run: true checks it and writes nothing.',
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      recurring_journal_id: { type: 'string' },
      enable: { type: 'boolean', description: 'Default false (pause). true resumes a paused template.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['recurring_journal_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'recurring_journal_id');
    if (!id) return toolError('recurring_journal_id is required');
    const bad = guardCastableArgs(args, { uuid: ['recurring_journal_id'] });
    if (bad) return bad;
    if (args.enable !== undefined && typeof args.enable !== 'boolean') return toolError('enable must be true or false');
    const enable = args.enable === true;

    const rj = await getRecurringJournalById(ctx.companyId, id);
    if (!rj) return toolError(NOT_FOUND);
    const base = { recurring_journal_id: id, template_name: rj.templateName };
    const target = enable ? 'active' : 'paused';
    // Already there, or (pausing) not running at all: nothing to write — the key stays free.
    if (rj.status === target || (!enable && rj.status !== 'active')) {
      return { ...ok({ ...base, status: rj.status, already: true }), wroteNothing: true };
    }
    if (enable && rj.status !== 'paused') {
      return toolError(`A ${rj.status} recurring journal cannot be resumed. Create a new one with create_recurring_journal.`);
    }
    if (enable && rj.autoPost && !mayPost(ctx)) return toolError(POSTS_NEED_WRITE_POST);

    const answer = { ...base, previous_status: rj.status, status: target };
    if (args.dry_run === true) return { ...ok({ dry_run: true, ...answer }), wroteNothing: true };
    // Predicated on the status just read: a change that landed in between is a NotFound throw, nothing written.
    await updateRecurringJournalStatus(ctx.companyId, id, target, rj.status);
    return ok(answer);
  },
};
