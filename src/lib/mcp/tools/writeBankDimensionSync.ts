/**
 * MCP write tool: sync_bank_dimensions — back-fill the CC1 / CC2 / BU of ALLOCATED
 * bank transactions from their journals (dimensionBankSync.ts has the rule).
 *
 * Mirror semantics (Hein): the bank row takes its journal's agreed set, NULLs
 * included, so a journal tagged CC1-only BLANKS the row's CC2 and BU. dry_run
 * lists every row where a value would become NULL (`would_blank`), so the caller
 * sees it before the live call.
 *
 * Scope: `write:journals` WITHOUT requiresPost, deliberately. This tool writes
 * no journal line and posts nothing — it changes the bank rows' own dimension
 * columns only, which no report reads — so the scope that gates changing what is
 * in the ledger (write:post) is not asked for. Its undo, reverse_dimension_tag_batch,
 * IS requiresPost because a batch it reverses may hold journal lines: undoing a
 * sync therefore needs write:post, which the caller of this tool may not hold.
 */
import type { McpTool } from '../types';
import {
  applyBankSyncBatch, MAX_BANK_SYNC_ROWS, previewBankSync, type BankSyncCandidate,
} from '@/modules/accounting/services/gl/dimensions/dimensionBankSync';
import { assertKeyIsFor, findTagBatchByKey } from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';
import { ok, strArg, toolError } from './toolHelpers';

const SYNC_KEYS = new Set(['date_from', 'date_to', 'reason', 'dry_run', 'idempotency_key']);

const wireRow = (s: BankSyncCandidate) => ({
  bank_transaction_id: s.bankTransactionId, date: s.transactionDate, amount: s.amount, description: s.description,
  old: { cc1_id: s.old.cc1Id, cc2_id: s.old.cc2Id, bu_id: s.old.buId },
  new: { cc1_id: s.next.cc1Id, cc2_id: s.next.cc2Id, bu_id: s.next.buId },
  blanks: s.blanks,
});

export const syncBankDimensionsTool: McpTool = {
  name: 'sync_bank_dimensions',
  description:
    'Make each ALLOCATED bank transaction carry the CC1 / CC2 / BU of its journal, so the Banking screen shows what '
    + 'the ledger carries (journal lines tagged before tag_journal_lines wrote through to the bank row). The bank row '
    + 'MIRRORS the journal: it takes the one set its POSTED journal\'s dimension lines (every line but the bank leg '
    + 'that is not on a control account: bank, AP, AR, VAT, payroll clearing) agree on, NULLs included — a journal '
    + 'tagged CC1-only BLANKS the row\'s CC2 and BU. A journal whose lines disagree (a split across projects, or one '
    + 'line tagged and another not) is left alone and shown as Split; a journal carrying no dimension at all '
    + '(a supplier payment) leaves the row\'s own tags alone. date_from / date_to (bank transaction_date, inclusive) '
    + `are required, and one run changes at most ${MAX_BANK_SYNC_ROWS} rows — narrow the window over that. `
    + 'DIMENSIONS ONLY — no amount, status or allocation moves. dry_run returns the count, a sample and `would_blank`: '
    + 'EVERY row where a value now held would become NULL, with the slots in `blanks` — read it before the live call. '
    + 'The live call records every row\'s old values under a batch_id; undo it with reverse_dimension_tag_batch '
    + '(which needs write:post).',
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      date_from: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      date_to: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      reason: { type: 'string' },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['date_from', 'date_to', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const extra = Object.keys(args).filter((k) => !SYNC_KEYS.has(k));
    if (extra.length > 0) return toolError(`Unknown argument(s): ${extra.join(', ')}. sync_bank_dimensions changes dimensions only.`);
    const key = strArg(args, 'idempotency_key');
    if (!key) return toolError('idempotency_key is required');
    const dateFrom = strArg(args, 'date_from');
    const dateTo = strArg(args, 'date_to');
    if (dateFrom === undefined || dateTo === undefined) return toolError('date_from and date_to are required (bank transaction_date window)');
    if (!isLedgerDate(dateFrom) || !isLedgerDate(dateTo)) return toolError(`date_from and date_to ${LEDGER_DATE_MESSAGE}`);
    if (dateFrom > dateTo) return toolError('date_from must not be after date_to');

    const scope = { dateFrom, dateTo };
    const prior = await findTagBatchByKey(ctx.companyId, key);
    if (prior) {
      assertKeyIsFor(prior, key, scope);
      return ok({ batch_id: prior.batchId, replayed: true });
    }

    if (args.dry_run === true) {
      const p = await previewBankSync(ctx.companyId, scope);
      const preview = ok({
        dry_run: true, batch_id: null, would_sync: p.count, max_rows: p.maxRows, over_max_rows: p.overMaxRows,
        would_blank: p.blanking.map(wireRow),
        sample: p.sample.map(wireRow),
      });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }
    // No catch: a failure after the first write must reach the registry's savepoint.
    const applied = await applyBankSyncBatch(ctx.companyId, scope, {
      idempotencyKey: key, reason: strArg(args, 'reason'), userId: ctx.userId,
    });
    return ok({ batch_id: applied.batchId, bank_rows_synced: applied.bankRowCount });
  },
};
