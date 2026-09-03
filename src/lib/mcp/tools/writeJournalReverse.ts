/**
 * MCP write tool: `reverse_journal_entry`.
 *
 * Reversal existed over MCP for bank allocations only. A manual journal —
 * including a correction journal an agent had just posted — had no reversal
 * path at all, so the only remedy for a wrong journal was another journal
 * written by hand, which leaves two entries and no link between them.
 *
 * This is a WRAP of `gl/journalEntryPostingService#reverseJournalEntry`, which
 * already implements the accounting correctly and is not reimplemented here:
 * the ORIGINAL keeps `status = 'posted'` and a posted contra entry offsets it,
 * so the pair nets to zero in every posted-only report. "Reversed" is metadata
 * (`reversed_at` / `reversed_by` / `reversal_of_id`), not a status flip —
 * flipping the original out of `posted` used to drop it from posted-only
 * reports while the contra stayed, driving the account to the NEGATIVE of the
 * original rather than to zero.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunResult } from '@/lib/mcp/contracts';
import {
  getJournalEntryById,
  resolveReversalDate,
  reverseJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { fmtDate } from '@/lib/fmtDate';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

const TOOL = 'reverse_journal_entry';

export const reverseJournalEntryTool: McpTool = {
  name: TOOL,
  description:
    'Reverse a POSTED journal entry by posting a contra entry that offsets it line for line. '
    + 'The original KEEPS status "posted" and is marked reversed in metadata, so the pair nets to '
    + 'zero in every report rather than the account swinging to the negative of the original. '
    + 'DATE: the contra is dated to the ORIGINAL entry date when that fiscal period is still '
    + 'open, and to TODAY when it is closed — a correction belongs in the period it corrects. '
    + 'Override with reversal_date, which must be a real YYYY-MM-DD day, must not fall before the '
    + 'entry being reversed, and must land in a fiscal period that EXISTS and is open. '
    + 'Refuses an entry that is a draft, already reversed, or has no lines. '
    + 'Does NOT cover: bank allocations (reverse_bank_allocation, or reverse_allocations for a '
    + 'date range) — reversing their journal directly would leave the bank transaction still '
    + 'marked allocated and pointing at an entry that has been undone. It also does not delete '
    + 'anything: both entries stay in the ledger, which is the point. '
    + 'Run with dry_run first: it reports the contra lines that would post and writes nothing.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      journal_entry_id: { type: 'string', description: 'The posted entry to reverse, from list_journals.' },
      reversal_date: {
        type: 'string',
        format: 'date',
        description:
          'YYYY-MM-DD. Omit to use the default (the original entry date when its period is open, '
          + 'otherwise today).',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['journal_entry_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'journal_entry_id');
    if (!id) return toolError('journal_entry_id is required');
    const bad = guardCastableArgs(args, { uuid: ['journal_entry_id'], date: ['reversal_date'] });
    if (bad) return bad;
    const reversalDate = strArg(args, 'reversal_date');

    // Every refusal is answered from READS so the service call below needs no
    // catch. reverseJournalEntry raises these itself, but a `catch -> toolError`
    // cannot tell them from a failure AFTER the contra was posted — and a
    // refusal is audited with a NULL idempotency key, so the agent's retry on
    // that key would post a second contra.
    const entry = await getJournalEntryById(ctx.companyId, id);
    if (!entry) return toolError(NOT_FOUND);
    if (entry.status !== 'posted') {
      return toolError(
        `Journal entry ${entry.entryNumber} is a ${entry.status}, and only a posted entry can be `
        + 'reversed. Delete a draft instead.',
      );
    }
    if (entry.reversedAt) {
      return toolError(`Journal entry ${entry.entryNumber} has already been reversed.`);
    }
    if (!entry.lines || entry.lines.length === 0) {
      return toolError(`Journal entry ${entry.entryNumber} has no lines to reverse.`);
    }

    // The date guards live in one place (resolveReversalDate) and are run here
    // read-only, so a bad date refuses with its own message instead of reaching
    // the agent as a generic failure from inside the write path.
    const originalDate = fmtDate(entry.entryDate);
    let resolvedDate: string;
    try {
      resolvedDate = await resolveReversalDate(ctx.companyId, originalDate, reversalDate);
    } catch (err) {
      return toolError(safeErrorText(err, 'Could not reverse this journal entry.'));
    }

    if (args.dry_run === true) {
      const result: DryRunResult = {
        dryRun: true,
        journals: [{
          date: resolvedDate,
          description: `Reversal of ${entry.entryNumber}`,
          fiscalPeriodId: null,
          lines: entry.lines.map((l) => ({
            accountId: l.glAccountId,
            accountCode: l.accountCode ?? '',
            accountName: l.accountName ?? '',
            // Debits and credits swap. This is the whole content of a reversal
            // and is worth showing rather than asserting.
            debit: l.credit,
            credit: l.debit,
          })),
          totalDebit: entry.lines.reduce((s, l) => s + l.credit, 0),
          totalCredit: entry.lines.reduce((s, l) => s + l.debit, 0),
        }],
        skipped: [],
        effects: [],
        journalsTotal: 1,
        truncated: false,
      };
      // wroteNothing keeps the idempotency key free — without it the real call
      // that follows is served this preview forever.
      return { ...ok(result), wroteNothing: true };
    }

    // Nothing below is caught.
    const reversal = await reverseJournalEntry(ctx.companyId, id, ctx.userId, {
      postingAgent: mcpPostingAgent(TOOL),
      ...(reversalDate ? { reversalDate } : {}),
    });

    return ok({
      reversed_entry_id: id,
      reversed_entry_number: entry.entryNumber,
      reversal_entry_id: reversal.id,
      reversal_entry_number: reversal.entryNumber,
      reversal_date: fmtDate(reversal.entryDate),
      // Stated because it is the property people get wrong about reversals here.
      original_status: 'posted',
      note: 'The original entry stays posted and is marked reversed in metadata; the contra entry offsets it.',
    });
  },
};
