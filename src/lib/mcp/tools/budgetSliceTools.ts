/**
 * MCP write tool submit_budget_for_review (budget tools PR 3): a budget holder submits their slice of a draft
 * version for review, the one slice move the app lets a non-approver make (sliceReviewState: open | returned →
 * submitted, by a holder of that slice). Approve and return are a reviewer's (owner / admin) in the app and are not
 * offered here. Through `transitionSlice` as the token user (POST /api/accounting/budgets/slices/[id]/submit): its
 * rules, lock order, audit row and the reviewers' notification. A refusal it raises reaches the agent with its
 * message (BUDGET_SLICE_* are refusal codes) after the registry's savepoint rolled the call back.
 */
import { UUID_RE } from '@/lib/validation';
import { listSlices, readSlice, type SliceReview } from '@/modules/accounting/services/budgets/sliceReviewRead';
import { transitionSlice } from '@/modules/accounting/services/budgets/sliceReviewState';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import { BUDGET_WRITE_FENCE, isResult, ownVersion } from './budgetToolArgs';
import { NOT_FOUND, ok, toolError } from './toolHelpers';
import { sliceLimit } from './budgetToolRateLimits';

const SUBMITTABLE = new Set(['open', 'returned']);

const sliceView = (s: SliceReview) => ({
  id: s.id, version_id: s.versionId, version_name: s.versionName, fiscal_year: s.fiscalYear, label: s.label, status: s.status,
  due_date: s.dueDate, submitted_by: s.submittedBy, submitted_at: s.submittedAt, decided_at: s.decidedAt, decision_note: s.decisionNote,
});

/** The slice to submit: the one named, or the token user's one open / returned slice of the version. */
async function sliceToSubmit(ctx: McpToolContext, args: Record<string, unknown>): Promise<SliceReview | McpToolResult> {
  if (args.slice_id !== undefined) {
    if (typeof args.slice_id !== 'string' || !UUID_RE.test(args.slice_id)) return toolError('invalid slice_id');
    try {
      return await readSlice(ctx.companyId, args.slice_id.toLowerCase());
    } catch (err) {
      if (err instanceof BudgetVersionError && err.code === 'BUDGET_SLICE_NOT_FOUND') return toolError(NOT_FOUND);
      throw err;
    }
  }
  if (args.version_id === undefined) return toolError('Pass slice_id, or version_id to submit your one open slice of that version');
  const version = await ownVersion(ctx, args.version_id);
  if (isResult(version)) return version;
  const mine = (await listSlices(ctx.companyId, { userId: ctx.userId, role: ctx.companyRole ?? '' }, { versionId: version.id }))
    .filter((s) => SUBMITTABLE.has(s.status) && s.holders.some((h) => h.userId === ctx.userId));
  if (mine.length === 0) return toolError('You hold no open or returned budget slice in this version (a slice submitted or approved is with its reviewer)');
  if (mine.length > 1) {
    return toolError(`You hold ${mine.length} budget slices that can be submitted in this version; name one with slice_id: `
      + JSON.stringify(mine.slice(0, 50).map((s) => ({ slice_id: s.id, label: s.label, status: s.status }))));
  }
  return mine[0]!;
}

export const submitBudgetForReviewTool: McpTool = {
  name: 'submit_budget_for_review',
  description:
    'Submit your budget slice of a DRAFT version for review (a budget holder\'s Submit in the app: open or returned → submitted). The owners and admins are notified. '
    + 'TRAPS FIRST: only a holder of that slice may submit it; once submitted, its cells and its drivers\' cells are frozen until a reviewer approves or returns it (in IsaFlow: approving and returning are a person\'s, not offered here); '
    + 'refused on an approved or locked version. slice_id names the slice; or version_id submits your ONE open or returned slice of that version (several: refused with their ids). '
    + 'dry_run true checks it all and submits nothing. Audited as you. Needs write:budgets and read:reports.',
  ...BUDGET_WRITE_FENCE,
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      slice_id: { type: 'string', format: 'uuid' }, version_id: { type: 'string', format: 'uuid' },
      dry_run: { type: 'boolean' }, idempotency_key: { type: 'string' },
    },
    required: ['idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (args.slice_id === undefined && args.version_id === undefined) return toolError('Pass slice_id, or version_id to submit your one open slice of that version');
    const limited = await sliceLimit(ctx);
    if (limited) return limited;
    const slice = await sliceToSubmit(ctx, args);
    if (isResult(slice)) return slice;
    const actor = { userId: ctx.userId, role: ctx.companyRole ?? '' };
    if (args.dry_run === true) {
      try {
        await inRolledBackSavepoint('mcp_budget_slice_dry', () => transitionSlice(ctx.companyId, slice.id, 'submit', actor));
      } catch (err) {
        if (err instanceof BudgetVersionError) return toolError(`The submit would be refused: ${err.message}`);
        throw err;
      }
      return { ...ok({ dry_run: true, slice: sliceView(slice), next_step: 'Call again with dry_run false to submit it.' }), wroteNothing: true };
    }
    const moved = await transitionSlice(ctx.companyId, slice.id, 'submit', actor);
    return ok({ slice: sliceView(moved), next_step: 'Submitted: an owner or admin reviews it in IsaFlow (approve, or return with a note).' });
  },
};
