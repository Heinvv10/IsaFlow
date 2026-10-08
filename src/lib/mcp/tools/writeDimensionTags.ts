/**
 * MCP write tools: dimension-only back-tagging of POSTED journal lines, and its undo.
 *
 * `tag_journal_lines` changes cc1_id / cc2_id / bu_id and NOTHING else. The
 * request has no field for an amount, account, date, description or VAT code,
 * and — because the transport does not enforce `additionalProperties` — the
 * handler itself REFUSES any key it does not know, at the top level and on
 * every line, so an agent that sends `debit` or `gl_account_id` is told so
 * rather than silently ignored. Every changed line is written to a
 * dimension_tag_batches row with its old values; `reverse_dimension_tag_batch`
 * restores them.
 *
 * requiresPost: both rewrite POSTED ledger lines in place (as merge_gl_accounts
 * does), and write:post is the scope that gates changing what is in the ledger.
 * Lines in a CLOSED period are allowed — amounts never move, so the AFS and the
 * VAT201 are untouched — and the batch is marked a restatement (brief §8.4).
 */
import type { McpTool } from '../types';
import { planDimensionTags, MAX_TAG_LINES, type TagLineInput } from '@/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import {
  applyDimensionTags, applyTagBatchReversal, findTagBatchByKey, planTagBatchReversal,
} from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { NOT_FOUND, ok, strArg, toolError } from './toolHelpers';

const TOP_KEYS = new Set(['lines', 'reason', 'dry_run', 'idempotency_key']);
const LINE_KEYS = new Set(['journal_line_id', 'cc1', 'cc2', 'bu', 'unallocated_reason']);

const DIM_VALUE = {
  type: ['string', 'null'],
  description: 'Code, UUID or alias to set; null clears it; omit to leave it unchanged.',
} as const;

function parseTagLines(raw: unknown): TagLineInput[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'lines must be a non-empty array of {journal_line_id, cc1?, cc2?, bu?}';
  if (raw.length > MAX_TAG_LINES) return `lines holds ${raw.length} entries — at most ${MAX_TAG_LINES} per call`;
  const out: TagLineInput[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return `lines[${i}] must be an object`;
    const o = entry as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !LINE_KEYS.has(k));
    if (extra.length > 0) {
      return `lines[${i}] carries ${extra.join(', ')}: tag_journal_lines changes dimensions only (cc1, cc2, bu) — `
        + 'never an amount, account, date or VAT code.';
    }
    const id = typeof o.journal_line_id === 'string' ? o.journal_line_id.trim() : '';
    if (!id) return `lines[${i}].journal_line_id is required`;
    const line: TagLineInput = { journalLineId: id };
    for (const kind of ['cc1', 'cc2', 'bu'] as const) {
      const v = o[kind];
      if (v === undefined) continue;
      if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 255)) {
        return `lines[${i}].${kind} must be a code, UUID or alias, or null to clear`;
      }
      line[kind] = v === null ? null : v.trim();
    }
    if (o.unallocated_reason !== undefined) {
      if (typeof o.unallocated_reason !== 'string' || o.unallocated_reason.length > 500) {
        return `lines[${i}].unallocated_reason must be text of at most 500 characters`;
      }
      line.unallocatedReason = o.unallocated_reason;
    }
    if (line.cc1 === undefined && line.cc2 === undefined && line.bu === undefined && !line.unallocatedReason) {
      return `lines[${i}] names no dimension to change`;
    }
    out.push(line);
  }
  return out;
}

export const tagJournalLinesTool: McpTool = {
  name: 'tag_journal_lines',
  description:
    'Back-tag up to 500 POSTED journal lines with CC1 (FNO), CC2 (project) and/or BU — DIMENSIONS ONLY. '
    + 'Amounts, accounts, dates and VAT codes never change; any other field is refused. A CC2 derives its FNO; a '
    + 'conflicting cc1 is refused. Control-account lines (bank, AP, AR, VAT, payroll clearing) and settlement, '
    + 'receipt, transfer and VAT-payment journals are refused — the cost line carries the dimensions. Lines in a '
    + 'closed period are allowed and the batch is flagged a restatement. Returns a batch_id; undo it with '
    + 'reverse_dimension_tag_batch. Use dry_run first.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TAG_LINES,
        items: {
          type: 'object',
          properties: {
            journal_line_id: { type: 'string', description: 'gl_journal_lines id (general_ledger / search_gl)' },
            cc1: DIM_VALUE,
            cc2: DIM_VALUE,
            bu: DIM_VALUE,
            unallocated_reason: { type: 'string', description: 'Why the line is tagged to the (unallocated) project.' },
          },
          required: ['journal_line_id'],
          additionalProperties: false,
        },
      },
      reason: { type: 'string', description: 'What this batch is, e.g. "FY26 back-tag from Lew ledger, Mar 2025".' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['lines', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const extra = Object.keys(args).filter((k) => !TOP_KEYS.has(k));
    if (extra.length > 0) return toolError(`Unknown argument(s): ${extra.join(', ')}. tag_journal_lines changes dimensions only.`);
    const items = parseTagLines(args.lines);
    if (typeof items === 'string') return toolError(items);
    const key = strArg(args, 'idempotency_key');
    if (!key) return toolError('idempotency_key is required');

    const prior = await findTagBatchByKey(ctx.companyId, key);
    if (prior) return ok({ batch_id: prior.batchId, tagged: prior.lineCount, is_restatement: prior.isRestatement, replayed: true });

    let plan: Awaited<ReturnType<typeof planDimensionTags>>;
    try {
      plan = await planDimensionTags(ctx.companyId, items);
    } catch (err) {
      if (isDimensionRefusal(err)) return toolError(err.message);
      throw err;
    }
    const summary = {
      would_tag: plan.lines.length,
      unchanged: plan.unchanged.length,
      is_restatement: plan.isRestatement,
      lines: plan.lines.map((l) => ({
        journal_line_id: l.journalLineId, entry_number: l.entryNumber, account_code: l.accountCode,
        old: { cc1_id: l.old.cc1Id ?? null, cc2_id: l.old.cc2Id ?? null, bu_id: l.old.buId ?? null },
        new: { cc1_id: l.next.cc1Id ?? null, cc2_id: l.next.cc2Id ?? null, bu_id: l.next.buId ?? null },
        period_closed: l.periodClosed,
      })),
      ...(plan.warnings.length > 0 ? { dimension_warnings: plan.warnings } : {}),
    };
    if (args.dry_run === true || plan.lines.length === 0) {
      const preview = ok({ dry_run: args.dry_run === true, batch_id: null, ...summary });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }
    // No catch: a failure after the first write must reach the registry's savepoint.
    const applied = await applyDimensionTags(ctx.companyId, plan, {
      idempotencyKey: key, reason: strArg(args, 'reason'), userId: ctx.userId,
    });
    return ok({ batch_id: applied.batchId, tagged: applied.lineCount, ...summary });
  },
};

export const reverseDimensionTagBatchTool: McpTool = {
  name: 'reverse_dimension_tag_batch',
  description:
    'Undo a tag_journal_lines batch: restore every line\'s previous CC1 / CC2 / BU. Refused when a line was '
    + 're-tagged by a later batch — reverse that one first. Changes dimensions only.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      batch_id: { type: 'string' },
      reason: { type: 'string' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['batch_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const batchId = strArg(args, 'batch_id');
    if (!batchId) return toolError('batch_id is required');
    let plan: Awaited<ReturnType<typeof planTagBatchReversal>>;
    try {
      plan = await planTagBatchReversal(ctx.companyId, batchId);
    } catch (err) {
      if (isDimensionRefusal(err)) return toolError(err.message === 'Not found' ? NOT_FOUND : err.message);
      throw err;
    }
    if (args.dry_run === true) {
      const preview = ok({ dry_run: true, batch_id: plan.batchId, would_restore: plan.lineCount, is_restatement: plan.isRestatement });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }
    await applyTagBatchReversal(ctx.companyId, plan, { userId: ctx.userId, reason: strArg(args, 'reason') });
    return ok({ batch_id: plan.batchId, restored: plan.lineCount, is_restatement: plan.isRestatement });
  },
};
