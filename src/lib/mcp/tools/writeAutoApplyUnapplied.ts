/**
 * MCP write tool: apply the backlog of unapplied cash to the documents it
 * obviously settles.
 *
 * `list_unapplied_payments` and `list_unapplied_receipts` REPORT the backlog;
 * this is the remedy. Every payment it touches is already in the ledger, so no
 * journal posts and no document is created — only the subledger moves into
 * agreement with the control account the cash already reached.
 *
 * DRY RUN IS THE DEFAULT, which is the opposite of every other write tool here
 * and deliberate: this call can touch hundreds of documents an agent did not
 * name individually, so the safe reading of an under-specified request is
 * "show me". A dry run writes nothing, is not billed, and does NOT occupy the
 * idempotency key — the live call that follows carries the same intent and
 * would otherwise be served the preview forever.
 *
 * THE KEY IS REQUIRED EVEN FOR A DRY RUN. registry.call() demands one from
 * every `write: true` tool before the handler is reached, so a conditional
 * requirement is not expressible here; `bulk_allocate_bank_transactions` has
 * the same shape for the same reason.
 */
import type { McpTool } from '../types';
import {
  autoApplyUnapplied,
  DEFAULT_BACKFILL_LIMIT,
  MAX_BACKFILL_LIMIT,
} from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { SUBLEDGERS, type Subledger } from '@/modules/accounting/services/shared/autoApplyBackfillPlan';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'auto_apply_unapplied';

/** The argument checks, as a bare function so a unit test can reach them. */
export function parseAutoApplyUnappliedArgs(args: Record<string, unknown>): {
  subledger: Subledger; entityId: string | null; dryRun: boolean; limit: number;
} | string {
  const subledger = strArg(args, 'subledger');
  if (!subledger || !(SUBLEDGERS as readonly string[]).includes(subledger)) {
    return `subledger must be one of ${SUBLEDGERS.join(', ')}`;
  }
  // Absent means TRUE. Only an explicit `false` runs live: an agent that
  // omitted the flag has not asked for a write over documents it never named.
  const rawDryRun = args.dry_run;
  if (rawDryRun !== undefined && typeof rawDryRun !== 'boolean') {
    return 'dry_run must be a boolean';
  }
  const rawLimit = args.limit;
  if (rawLimit !== undefined
    && (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1)) {
    return 'limit must be a positive number';
  }
  return {
    subledger: subledger as Subledger,
    entityId: strArg(args, 'entity_id') ?? null,
    dryRun: rawDryRun !== false,
    limit: Math.min(Math.floor(rawLimit ?? DEFAULT_BACKFILL_LIMIT), MAX_BACKFILL_LIMIT),
  };
}

export const autoApplyUnappliedTool: McpTool = {
  name: TOOL,
  description:
    'Apply the BACKLOG of unapplied supplier payments, customer receipts and credit notes to the '
    + "documents they settle: each contact's oldest open documents first, part-paying the one the "
    + 'money runs out on, oldest cash first so a later payment sees what an earlier one consumed. '
    + 'POSTS NO JOURNAL and creates no document — the cash is already in the ledger, and only the '
    + 'subledger moves. Cash is never applied across contacts, and whatever is left over stays on '
    + 'the payment as on-account credit. '
    + 'DRY RUN IS THE DEFAULT: without dry_run:false it writes nothing and returns the full plan, '
    + 'including "no_open_documents" — the payments with nothing open to apply to, which is usually '
    + 'the larger half of the backlog and the part a human has to look at. '
    + 'A live run applies each payment in its own savepoint, so a failure on one is reported in '
    + '"failed" and the rest still apply. Re-running is safe: an applied payment has no remainder '
    + 'left and is not in the population, so a second run reports 0. Every application is an '
    + 'ordinary allocation row, so void_payment / void_receipt reverse it. '
    + 'Scope it with entity_id to one supplier or customer, and limit to cap how many payments one '
    + 'call walks.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      subledger: {
        type: 'string',
        enum: [...SUBLEDGERS],
        description: '"ap" for supplier payments and supplier credit notes, "ar" for customer receipts and customer credit notes.',
      },
      entity_id: {
        type: 'string',
        description: 'One supplier (ap) or customer (ar). Omit for the whole subledger.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Defaults to TRUE. Pass false to actually apply the plan.',
      },
      limit: {
        type: 'number',
        description: `How many payments to walk, oldest first. Default ${DEFAULT_BACKFILL_LIMIT}, max ${MAX_BACKFILL_LIMIT}.`,
      },
      idempotency_key: { type: 'string' },
    },
    required: ['subledger', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['entity_id'] });
    if (guard) return guard;
    const parsed = parseAutoApplyUnappliedArgs(args);
    if (typeof parsed === 'string') return toolError(parsed);

    const plan = await autoApplyUnapplied({
      companyId: ctx.companyId,
      userId: ctx.userId,
      subledger: parsed.subledger,
      entityId: parsed.entityId,
      dryRun: parsed.dryRun,
      limit: parsed.limit,
      idempotencyKey: strArg(args, 'idempotency_key') ?? null,
    });

    const result = ok(plan);
    if (parsed.dryRun) {
      // Wrote nothing, so it must neither be billed nor occupy the key.
      result.wroteNothing = true;
      result.billable = false;
    } else if (plan.totals.applied === 0) {
      // A live run that found nothing left to apply did no billable work — the
      // shape a re-run takes, which the description invites.
      result.billable = false;
    }
    return result;
  },
};
