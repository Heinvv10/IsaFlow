/**
 * run_recurring_journals — generate the month's due runs of every active recurring journal template, through the
 * app's own generator (gl/recurringJournalPeriodRun → runRecurringJournal): exactly once per run, in date order,
 * honouring the fiscal period, the VAT lock and the manual-journal approval rules as the Generate button does.
 *
 * Scope is write:journals; a template that POSTS its journals additionally needs write:post (decided per template,
 * as an auto-posting bank rule is), and without it that template is reported, not run. An agent raises no approval
 * (R-035 Q6): a posting template whose journal approval would hold is reported instead.
 *
 * Every skip is decided before that template's run writes, or rolled back with it, so the answer is a success that
 * lists them. A success that generated nothing — and every dry run — sets wroteNothing, so the key stays free.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { mcpPostingOpts } from '../mcpActor';
import {
  periodBounds, runRecurringJournalsForPeriod,
} from '@/modules/accounting/services/gl/recurringJournalPeriodRun';
import { ok, strArg, toolError } from './toolHelpers';

export const runRecurringJournalsTool: McpTool = {
  name: 'run_recurring_journals',
  description:
    'Generate the journals that recurring journal templates have due in one month (period, YYYY-MM), for every active '
    + 'template — each run exactly once: re-running a month generates nothing new. Each journal is dated its run date. '
    + 'A template with auto_post posts its journal (needs write:post; without it the template is skipped); otherwise '
    + 'it is left a draft. Runs after today, in a closed fiscal period, in a locked VAT period, needing approval, or '
    + 'on a deactivated account are skipped with the reason, as is a run in a period the template already generated (period_already_generated), a template past its end_date (ended) or still '
    + 'behind an earlier month (run that month first). Returns generated[] with journal_id per run, and skipped[]. dry_run: true lists what would be '
    + 'generated and writes nothing. Undo a posted journal with reverse_journal_entry.',
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', description: 'The month to generate, YYYY-MM.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['period', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const period = strArg(args, 'period');
    if (!period || !periodBounds(period)) return toolError('period is required, as YYYY-MM');
    const dryRun = args.dry_run === true;
    const run = await runRecurringJournalsForPeriod(ctx.companyId, ctx.userId, period, {
      canPost: ctx.scopes.includes('write:post'),
      dryRun,
      run: { meta: mcpPostingOpts(ctx, 'run_recurring_journals'), agent: true },
    });
    const generated = run.generated.map((g) => ({
      recurring_journal_id: g.templateId, template_name: g.templateName, run_date: g.runDate,
      ...(dryRun ? {} : { journal_id: g.journalId }),
      status: g.posted ? 'posted' : 'draft',
      ...(g.warnings ? { warnings: g.warnings } : {}),
    }));
    const skipped = run.skipped.map((s) => ({
      recurring_journal_id: s.templateId, template_name: s.templateName, run_date: s.runDate,
      reason: s.reason, message: s.message,
    }));
    const body = {
      period: run.period, period_start: run.periodStart, period_end: run.periodEnd,
      ...(dryRun
        ? { dry_run: true, would_generate: generated }
        : { generated, journal_ids: run.generated.map((g) => g.journalId) }),
      skipped,
    };
    const wroteNothing = dryRun || run.generated.length === 0;
    return wroteNothing ? { ...ok(body), wroteNothing: true } : ok(body);
  },
};
