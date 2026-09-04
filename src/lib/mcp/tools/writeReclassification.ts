/**
 * `post_reclassification_batch` — the write half of `propose_reclassification`.
 *
 * IT NEVER MUTATES A POSTED LINE. For each source line it posts a contra on the
 * source account and the same amount re-applied to the target, leaving the
 * original exactly as posted. `UPDATE gl_journal_lines SET gl_account_id = …`
 * would give the same closing balances and destroy three things: a signed trial
 * balance stops reproducing, the original classification is gone, and there is
 * nothing to reverse. The pair IS the record that the reclassification happened.
 *
 * ALL-OR-NOTHING, by the same mechanism as `bulk_allocate_bank_transactions`:
 * `registry.call()` wraps this handler in ONE savepoint that unwinds only on a
 * THROW. So the plan — which is entirely pre-write — may return a `toolError`,
 * and from the first `postReclassBatch` write onward nothing is caught. A
 * `catch → toolError` after a write would RELEASE the savepoint, let the
 * transport commit the journals already posted, AND free the idempotency key for
 * a retry that posts them a second time.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA } from '@/lib/mcp/contracts';
import { postReclassBatch } from '@/modules/accounting/services/gl/reclassification/post';
import { MAX_RECLASS_LINES } from '@/modules/accounting/services/gl/reclassification/plan';
import { mcpPostingOpts } from '../mcpActor';
import {
  RECLASS_ARG_SCHEMA,
  isPlan,
  planFromArgs,
  renderJournals,
  renderMovement,
  renderPeriods,
  renderSkips,
} from './reclassificationShared';
import { ok, strArg, toolError } from './toolHelpers';

const RECLASS_TOOL = 'post_reclassification_batch';

const DESCRIPTION = [
  'Move posted amounts from one GL account to another, as one reversible batch. RUN propose_reclassification FIRST, or call this with dry_run: true — it returns exactly what would post and writes nothing.',
  'HOW IT WORKS: it POSTS A NEW JOURNAL — a contra on the source account and the same amount re-applied to the target, one pair per source line — and leaves every original posted line untouched. Nothing is edited or deleted. Each journal is a normal posted entry, so the batch is undone with reverse_journal_entry on the ids returned, and both the original and the correction stay in the audit trail.',
  'THE CAVEAT THAT MATTERS MOST. If the source account is missing only an account_subtype, this is probably the WRONG remedy: setting the subtype with update_gl_account gets it into the classified bands of every report and moves nothing, while this merges the source account into the target permanently — after it, no report can tell the two apart. On real books most unclassified accounts are correctly named and correctly loaded, and moving them collapses distinct costs (direct material, sub-contractors, wayleave) into one line. The response warns with subtype_remedy_available and collapses_named_accounts when either applies; read them.',
  'PERIODS: with no posting_date each journal is dated at its own source line, so nothing crosses periods — and any line whose own fiscal period is CLOSED is skipped, because a closed period cannot be posted into. Pass posting_date to post the whole batch on one open day instead; the closed month then keeps its original classification and this period carries the correction.',
  `SKIPS versus FAILURES: a line the data will not let you move — closed period, no fiscal period, a reversed entry, already moved by an earlier batch, the contra leg of one — is SKIPPED with a reason and does not cost the rest. Anything else fails the WHOLE batch and nothing is posted. At most ${MAX_RECLASS_LINES} source lines per call; narrow with from/to rather than have a batch truncate. A call with nothing left to move posts nothing and opens no batch.`,
].join(' ');

export const postReclassificationBatchTool: McpTool = {
  name: RECLASS_TOOL,
  description: DESCRIPTION,
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...RECLASS_ARG_SCHEMA,
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['source_account_id', 'target_account_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // Everything the plan does is a READ, and it runs EVERY row-state guard the
    // write path runs. That is what makes the dry run below honest: only the
    // write itself is skipped.
    const planned = await planFromArgs(args, ctx);
    if (!isPlan(planned)) return planned;

    const postingDate = strArg(args, 'posting_date') ?? null;

    if (args.dry_run === true) {
      const preview = ok({
        dryRun: true,
        batch_id: null,
        posted: 0,
        would_post_journals: planned.drafts.length,
        would_move_lines: planned.movable.length,
        warnings: planned.warnings,
        movement: renderMovement(planned),
        periods: renderPeriods(planned),
        journals: renderJournals(planned),
        skipped: renderSkips(planned),
        profit_and_loss_before: planned.impact.profitAndLossBefore,
        profit_and_loss_after: planned.impact.profitAndLossAfter,
        account_movement: planned.impact.accounts,
      });
      // Wrote nothing, so it must NOT occupy the idempotency key: the real call
      // that follows carries the same intent and would otherwise be served this
      // preview forever. Free for the same reason.
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }

    if (planned.movable.length === 0) {
      // Refused BEFORE anything is written, and deliberately not reported as a
      // success: an empty batch hands back an id that reverses nothing, and a
      // silent `posted: 0` reads like the work was done. Pre-write, so a
      // toolError is the right shape — the registry audits it with a NULL key
      // and the agent can retry on the same key once it has fixed its window.
      const reasons = [...new Set(planned.skipped.map((s) => s.reason))];
      return toolError(
        `Nothing to reclassify on ${planned.source.code}: ${planned.skipped.length} candidate `
        + `line${planned.skipped.length === 1 ? '' : 's'} skipped`
        + (reasons.length > 0 ? ` (${reasons.join(', ')})` : '')
        + '. Widen from/to, or pass posting_date to move lines out of closed periods.',
      );
    }

    // ── Everything below WRITES. No try/catch: a throw must reach the
    // registry's savepoint, which is the only thing that unwinds the journals
    // already posted. Catching here would commit a half-moved account.
    const result = await postReclassBatch(ctx.companyId, ctx.userId, {
      tool: RECLASS_TOOL,
      sourceAccountId: planned.source.id,
      targetAccountId: planned.target.id,
      postingDate,
      idempotencyKey: strArg(args, 'idempotency_key') ?? null,
      drafts: planned.drafts,
      // Stamped as the agent, on every journal. Without it a batch of hundreds
      // of corrections posts as human:<userId> and drops out of
      // list_agent_postings.
      actor: mcpPostingOpts(ctx, RECLASS_TOOL),
    });

    return ok({
      batch_id: result.batchId,
      posted: result.journals.length,
      moved_lines: result.movedLineCount,
      journal_entry_ids: result.journals.map((j) => j.journalEntryId),
      journals: result.journals,
      skipped: renderSkips(planned),
      warnings: planned.warnings,
      movement: renderMovement(planned),
      // Undo route, named in the response and not only in the description.
      reverse_with: 'reverse_journal_entry, once per id in journal_entry_ids',
    });
  },
};
