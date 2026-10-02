/**
 * MCP tools for reconciliation sessions: list them, and cancel an in-progress
 * one. Completing a reconciliation stays out of MCP — that is a sign-off a
 * person makes on a balanced screen, not something an agent should assert.
 *
 * Cancel is the counterpart of the UI's Cancel Reconciliation button: it
 * deletes the session and releases its transactions. Matches made inside the
 * session are undone; allocated rows keep their status and their journal, so
 * nothing leaves the GL.
 *
 * Reopen (R-111) is the way back from a COMPLETED one: the session returns to
 * in_progress and its reconciled lines to allocated/matched, newest first, so a
 * wrong allocation inside it can be reversed instead of hand-journalled.
 */
import type { McpTool } from '../types';
import { getReconciliations } from '@/modules/accounting/services/bank/bankReconciliationService';
import {
  cancelReconciliation,
  ReconciliationNotCancellableError,
} from '@/modules/accounting/services/bank/bankReconciliationCancelService';
import {
  reopenReconciliation,
  ReconciliationNotReopenableError,
} from '@/modules/accounting/services/bank/bankReconciliationReopenService';
import { clampLimit, guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';

export const listBankReconciliationsTool: McpTool = {
  name: 'list_bank_reconciliations',
  description:
    'Reconciliation sessions for the company, newest statement date first, with their status '
    + '(in_progress or completed), statement and reconciled balances, the outstanding difference, '
    + 'and matched/unmatched transaction counts. Read-only. Filter to one account with '
    + 'bank_account_id (a GL account id from bank_accounts_status).',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: { type: 'string' },
      status: { type: 'string', enum: ['in_progress', 'completed'] },
      limit: { type: 'number' },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const bad = guardCastableArgs(args, { uuid: ['bank_account_id'] });
    if (bad) return bad;
    const status = strArg(args, 'status');
    if (status && status !== 'in_progress' && status !== 'completed') {
      return toolError('status must be in_progress or completed');
    }
    const limit = clampLimit(args, 50, 200);
    try {
      // companyId from ctx ONLY — no tool accepts a tenant identifier.
      const all = await getReconciliations(ctx.companyId, bankAccountId);
      const filtered = status ? all.filter((r) => r.status === status) : all;
      return ok({
        reconciliations: filtered.slice(0, limit).map((r) => ({
          id: r.id,
          bank_account_id: r.bankAccountId,
          bank_account_name: r.bankAccountName ?? null,
          statement_date: r.statementDate,
          statement_balance: r.statementBalance,
          gl_balance: r.glBalance,
          reconciled_balance: r.reconciledBalance,
          difference: r.difference,
          status: r.status,
          matched_count: r.matchedCount ?? 0,
          unmatched_count: r.unmatchedCount ?? 0,
        })),
        total: filtered.length,
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to load reconciliations.'));
    }
  },
};

export const cancelBankReconciliationTool: McpTool = {
  name: 'cancel_bank_reconciliation',
  description:
    'Cancel an in-progress reconciliation: the session is deleted and every transaction it claimed '
    + 'is released back to the bank account. Matches made inside the session are undone (those rows '
    + 'return to "imported"); allocated, provisional and excluded rows keep their status and their '
    + 'journal entries and are only detached — nothing is removed from the GL. A completed '
    + 'reconciliation cannot be cancelled. Use dry_run to see how many transactions would be '
    + 'released before committing.',
  scope: 'write:bank-tx',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      reconciliation_id: {
        type: 'string',
        description: 'Id from list_bank_reconciliations. Must be in_progress.',
      },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['reconciliation_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const reconId = strArg(args, 'reconciliation_id');
    if (!reconId) return toolError('reconciliation_id is required');
    const bad = guardCastableArgs(args, { uuid: ['reconciliation_id'] });
    if (bad) return bad;
    const dryRun = args.dry_run === true;

    try {
      const result = await cancelReconciliation(ctx.companyId, reconId, ctx.userId, { dryRun });
      return {
        ...ok({
          reconciliation_id: reconId,
          cancelled: !dryRun,
          dry_run: dryRun,
          reverted_matches: result.revertedMatches,
          released_transactions: result.releasedTransactions,
        }),
        // A dry run wrote nothing, so it must not burn the idempotency key —
        // the real call that follows carries the same key and would otherwise
        // replay this preview forever.
        ...(dryRun ? { wroteNothing: true, billable: false } : {}),
      };
    } catch (err) {
      // A refusal is raised before anything is written (or after the service's
      // own transaction has already rolled back), so returning it as a tool
      // error leaves nothing half-applied. Anything else MUST rethrow: the
      // registry's savepoint unwinds on a throw only, and an isError result
      // would commit a partial cancel.
      if (err instanceof ReconciliationNotCancellableError) return toolError(err.message);
      throw err;
    }
  },
};

export const reopenBankReconciliationTool: McpTool = {
  name: 'reopen_bank_reconciliation',
  description:
    'Reopen a COMPLETED reconciliation so a wrong allocation inside it can be corrected. The '
    + 'session goes back to in_progress and every line completion marked reconciled returns to '
    + 'the state it had: allocated lines (they carry an allocation) to "allocated", matched lines to '
    + '"matched". Nothing is posted and no journal changes. While it is open, an allocated line can '
    + 'be reversed with reverse_bank_allocation (it leaves the session with its reversal); complete '
    + 'it again by running perform_bank_reconciliation on the same statement after '
    + 'cancel_bank_reconciliation, or complete the open session in the app. '
    + 'NEWEST FIRST: only the latest completed reconciliation on an account can be reopened — a '
    + 'statement opens at the closing balance of the one before, so reopening an older one under later '
    + 'sign-offs is refused and the refusal names how many later ones stand. Also refused when a '
    + 'session is already in progress on the account. reason is stored on the reconciliation as '
    + 'the audit record. dry_run runs every guard and reports how many lines would be restored, '
    + 'writing nothing. Requires the write:post permission.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      reconciliation_id: {
        type: 'string',
        description: 'Id from list_bank_reconciliations. Must be completed and the latest on its account.',
      },
      reason: {
        type: 'string',
        description: 'Why it is being reopened. Stored on the reconciliation.',
      },
      dry_run: { type: 'boolean' },
      idempotency_key: { type: 'string' },
    },
    required: ['reconciliation_id', 'reason', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const reconId = strArg(args, 'reconciliation_id');
    if (!reconId) return toolError('reconciliation_id is required');
    const reason = strArg(args, 'reason');
    if (!reason || !reason.trim()) return toolError('reason is required — it is the audit record of the reopen');
    const bad = guardCastableArgs(args, { uuid: ['reconciliation_id'] });
    if (bad) return bad;
    const dryRun = args.dry_run === true;

    try {
      const result = await reopenReconciliation(ctx.companyId, reconId, ctx.userId, { dryRun, reason });
      return {
        ...ok({
          reconciliation_id: reconId,
          reopened: !dryRun,
          dry_run: dryRun,
          bank_account_id: result.bankAccountId,
          statement_date: result.statementDate,
          restored_allocated: result.restoredAllocated,
          restored_matched: result.restoredMatched,
        }),
        ...(dryRun ? { wroteNothing: true, billable: false } : {}),
      };
    } catch (err) {
      // Refusals are raised before any write or after the service's own
      // transaction rolled back; anything else must rethrow so the registry's
      // savepoint unwinds a partial reopen.
      if (err instanceof ReconciliationNotReopenableError) return toolError(err.message);
      throw err;
    }
  },
};
