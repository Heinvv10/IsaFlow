/**
 * `propose_reclassification` — what moving posted amounts from one GL account
 * to another would do, before anyone does it.
 *
 * READ ONLY. It writes nothing, opens no batch, and costs no Flows.
 *
 * The two things it exists to put in front of a reader:
 *
 *   THE JOURNALS, not a count of them. A reclassification posts a contra on the
 *   source and a re-application on the target, per line — it never rewrites a
 *   posted line — and those journals are what a reviewer signs off.
 *
 *   THE CAVEAT. An account with no `account_subtype` is absent from the
 *   classified bands of every report, and moving its lines is only ONE of the
 *   two remedies. Setting the subtype is the other, and it moves nothing. Where
 *   the source is a properly named account that merely lacks a subtype, moving
 *   it merges its identity into the target permanently, and this endpoint says
 *   so rather than leaving it to be discovered afterwards.
 */
import type { McpTool } from '../types';
import { buildEnvelope, isDetailLevel, type DetailLevel } from '@/lib/mcp/contracts';
import { MAX_RECLASS_LINES } from '@/modules/accounting/services/gl/reclassification/plan';
import {
  RECLASS_ARG_SCHEMA,
  isPlan,
  planFromArgs,
  renderJournals,
  renderMovement,
  renderPeriods,
  renderSkips,
} from './reclassificationShared';
import { ok } from './toolHelpers';

const DESCRIPTION = [
  'Preview moving posted amounts from one GL account to another. Writes NOTHING.',
  'HOW A RECLASSIFICATION IS DONE HERE: it posts a NEW journal — a contra on the source account and the same amount re-applied to the target, one pair per source line — and leaves the original posted lines exactly as they are. It never rewrites gl_journal_lines. That is what keeps a trial balance somebody already signed reproducible, keeps the original classification visible to an auditor, and makes the batch undoable through reverse_journal_entry.',
  'RETURNS: every journal that would post in full; the profit and loss before and after, each aggregated independently over the ledger rather than one derived from the other; the source and target account movement; gross and net moved, stated separately because an account used for clearing can show R31.6m gross against R659k net and a net-only reading would call that harmless (movement.grossMoved and movement.netMoved are raw DEBIT-POSITIVE ledger movement; account_movement is normal-balance signed, so a credit-side move shows a negative netMoved); every line that would be skipped with a machine-stable reason; and the source journal entry ids behind all of it.',
  'READ THE WARNINGS BEFORE ACTING. no_profit_and_loss_effect means every band is identical before and after, so the move changes no reported figure at all and only merges two account names — which is what happens when both accounts already report in the same band (an expense with no subtype and one subtyped default_expense both land in operating expenses). subtype_remedy_available means the source account is simply missing an account_subtype: setting it with update_gl_account achieves the same reporting goal and MOVES NOTHING, whereas this move merges the source account into the target and no report can tell them apart afterwards. On real books most unclassified accounts are correctly named and correctly loaded — they only lack a subtype — and moving them destroys the split between, say, direct material, sub-contractors and wayleave. collapses_named_accounts means the target already carries value from elsewhere.',
  'PERIODS: with no posting_date each journal is dated at its own source line, so the period that incurred the cost keeps it and nothing crosses periods — but every line whose own period is CLOSED is skipped (source_period_closed), because a closed period cannot be posted into. Pass posting_date to date the whole batch in an open period instead; nothing is then skipped for a closed source period, and the charge moves between periods.',
  `LIMITS: at most ${MAX_RECLASS_LINES} source lines per call — narrow with from/to and run several batches rather than have a batch truncate. Draft journals are not candidates; only posted lines are. Lines on a reversed entry, lines an earlier live batch already moved, and the contra legs of an earlier reclassification are skipped. Post it with post_reclassification_batch.`,
].join(' ');

export const proposeReclassificationTool: McpTool = {
  name: 'propose_reclassification',
  description: DESCRIPTION,
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      ...RECLASS_ARG_SCHEMA,
      detail: {
        type: 'string',
        enum: ['summary', 'standard', 'full'],
        description:
          'summary: totals and warnings only. standard (default): the lines that would move. '
          + 'full: the same, plus every journal that would post.',
      },
    },
    required: ['source_account_id', 'target_account_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const planned = await planFromArgs(args, ctx);
    if (!isPlan(planned)) return planned;

    const rawDetail = typeof args.detail === 'string' ? args.detail : undefined;
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';

    const rows = planned.movable.map((m) => ({
      line_id: m.lineId,
      journal_entry_id: m.journalEntryId,
      entry_number: m.entryNumber,
      entry_date: m.entryDate,
      debit: m.debit,
      credit: m.credit,
      description: m.description,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: planned.movable.length,
      detail,
      as_at: planned.impact.window.end,
      posted_through: planned.postedThrough,
      excludedRows: renderSkips(planned).map((s) => ({
        id: s.id,
        reason: s.reason,
        amount: s.amount,
        documentNumber: s.entry_number ?? undefined,
        detail: `${s.entry_date} — journal ${s.journal_entry_id}`,
      })),
      // Its own COUNT over every posted line on the source account in the
      // window, run separately from the page. NOT `rowsTotal + skipped.length`,
      // which would make the identity incapable of failing.
      universeTotal: planned.universeTotal,
      figureBasis: 'gl.reclassification.v1',
    });

    return ok({
      ...envelope,
      source_account: {
        id: planned.source.id, code: planned.source.code, name: planned.source.name,
        type: planned.source.type, subtype: planned.source.subtype,
      },
      target_account: {
        id: planned.target.id, code: planned.target.code, name: planned.target.name,
        type: planned.target.type, subtype: planned.target.subtype,
      },
      warnings: planned.warnings,
      movement: renderMovement(planned),
      periods: renderPeriods(planned),
      // Two full aggregations over the same ledger window — the second with the
      // moved lines projected onto the target — folded by the one owned
      // classifier. Neither is computed from the other, and the `before` side is
      // checked against financialFiguresService: a disagreement arrives as the
      // `basis_disagreement` warning rather than being read as the move's effect.
      profit_and_loss_before: planned.impact.profitAndLossBefore,
      profit_and_loss_after: planned.impact.profitAndLossAfter,
      account_movement: planned.impact.accounts,
      journals: detail === 'full' ? renderJournals(planned) : [],
      journals_total: planned.drafts.length,
    });
  },
};
