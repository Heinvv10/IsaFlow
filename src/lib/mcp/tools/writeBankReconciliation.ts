/**
 * `perform_bank_reconciliation` — start a reconciliation, auto-match into it,
 * and complete it when and only when it balances.
 *
 * `list_bank_reconciliations` and `cancel_bank_reconciliation` existed; nothing
 * CREATED one. `unreconciledCount == txnCount` on every account in both audited
 * companies, which is exactly what you would expect when the only reconciliation
 * verbs are list and cancel.
 *
 * ── COMPLETING IS NOW POSSIBLE, AND ONLY AT ZERO ────────────────────────────
 *
 * Completion was deliberately withheld before, on the reasoning that it is "a
 * sign-off a person makes on a balanced screen". The reasoning was right about
 * BALANCED and wrong about the screen: the condition being signed off is
 * `difference == 0`, and that is machine-checkable. So `complete: true` is an
 * explicit opt-in, and the tool completes only when the session is exactly
 * balanced.
 *
 * ── WHY AN UNBALANCED SESSION IS A SUCCESS, NOT A REFUSAL ───────────────────
 *
 * By the time the difference is known, `startReconciliation` and
 * `autoMatchTransactions` have both written. A refusal at that point would have
 * to THROW to unwind them (the savepoint rolls back on a throw, not on a
 * returned error) — and throwing away the session and its matches is not what
 * an agent asking to reconcile wants. So the call SUCCEEDS, reports
 * `completed: false` with the difference, and leaves the session open for the
 * next step. It wrote, so the idempotency key is consumed: a retry must not
 * open a second session.
 */
import type { McpTool } from '../types';
import {
  autoMatchTransactions,
  completeReconciliation,
  getReconciliationById,
  getReconciliations,
  startReconciliation,
} from '@/modules/accounting/services/bank/bankReconciliationService';
import { bankGlAccountBelongsToCompany } from '@/modules/accounting/services/bank/bankStatementImportService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** Tolerance a reconciliation is considered balanced within. Matches the service. */
const BALANCED_TOLERANCE = 0.01;

export const performBankReconciliationTool: McpTool = {
  name: 'perform_bank_reconciliation',
  description:
    'Start a bank reconciliation for one account at a statement date and balance, claim every '
    + 'unreconciled imported transaction into it, auto-match those transactions to posted GL '
    + 'journal lines, and report the reconciled balance and the outstanding difference. '
    + 'Auto-matching only applies matches it scores at 0.9 confidence or better; anything weaker '
    + 'is returned as a candidate for a person and is NOT applied. '
    + 'It does NOT create journals: a transaction with nothing in the GL to match stays '
    + 'unmatched — allocate it with allocate_bank_transaction and reconcile again. '
    + 'complete defaults to false. With complete: true the session is completed ONLY when the '
    + 'difference is exactly zero AND at least one transaction was matched — an empty session '
    + 'balances trivially, because a reconciliation starts at the GL balance, and completing one '
    + 'proves nothing (production holds exactly such a reconciliation). When either condition '
    + 'fails the call still SUCCEEDS, reports '
    + 'completed: false with the difference, and leaves the session in progress so the matches are '
    + 'not thrown away — cancel_bank_reconciliation releases it if you want to start over. '
    + 'Refuses if a reconciliation is already in progress on the account. '
    + 'dry_run reports the GL balance at the statement date, the difference against the statement '
    + 'balance you supplied, and how many transactions would be claimed — and writes nothing. '
    + 'Requires the write:post permission.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: {
        type: 'string',
        description: 'The bank GL account id, from bank_accounts_status or list_gl_accounts.',
      },
      statement_date: {
        type: 'string',
        format: 'date',
        description: 'YYYY-MM-DD. The GL balance is taken up to and including this date.',
      },
      statement_balance: {
        type: 'number',
        description: 'The closing balance printed on the bank statement. Negative if overdrawn.',
      },
      auto_match: {
        type: 'boolean',
        description: 'Run auto-matching after starting. Default true.',
      },
      complete: {
        type: 'boolean',
        description:
          'Complete the reconciliation if it balances exactly. Default false. '
          + 'Completing marks every matched transaction reconciled and closes the session.',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['bank_account_id', 'statement_date', 'statement_balance', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const statementDate = strArg(args, 'statement_date');
    if (!bankAccountId) return toolError('bank_account_id is required');
    if (!statementDate) return toolError('statement_date is required (YYYY-MM-DD)');

    const bad = guardCastableArgs(args, {
      uuid: ['bank_account_id'],
      date: ['statement_date'],
    });
    if (bad) return bad;

    const statementBalance = args.statement_balance;
    if (typeof statementBalance !== 'number' || !Number.isFinite(statementBalance)) {
      return toolError('statement_balance must be a number');
    }

    const dryRun = args.dry_run === true;
    const autoMatch = args.auto_match !== false;
    const complete = args.complete === true;

    // Ownership BEFORE any service call: bank_account_id becomes a foreign key
    // and nothing downstream re-checks the tenant.
    if (!(await bankGlAccountBelongsToCompany(ctx.companyId, bankAccountId))) {
      return toolError(NOT_FOUND);
    }

    // A second in-progress session on one account would claim no transactions
    // (the first holds them all) and read as a reconciliation of nothing.
    // Answered from a READ so it is a pre-write refusal.
    const existing = await getReconciliations(ctx.companyId, bankAccountId);
    const inProgress = existing.find((r) => r.status === 'in_progress');
    if (inProgress) {
      return toolError(
        `A reconciliation is already in progress on this account (id ${inProgress.id}, statement `
        + `date ${inProgress.statementDate}, difference R${inProgress.difference.toFixed(2)}). `
        + 'Complete it or cancel it with cancel_bank_reconciliation before starting another.',
      );
    }

    if (dryRun) {
      // Every guard above has run. The GL side comes from cash.balance.v1's
      // owning service rather than being re-derived here.
      const cash = await getCashBalance(ctx.companyId, statementDate);
      const glBalance = cash.accounts.find((a) => a.accountId === bankAccountId)?.glBalance ?? 0;
      return {
        ...ok({
          dry_run: true,
          bank_account_id: bankAccountId,
          statement_date: statementDate,
          statement_balance: statementBalance,
          gl_balance: glBalance,
          difference: statementBalance - glBalance,
          would_auto_match: autoMatch,
          would_complete_if_balanced: complete,
          note:
            'Nothing was written. The difference shown is against the GL balance BEFORE any '
            + 'matching; the live call reports the difference after matching.',
        }),
        wroteNothing: true,
        billable: false,
      };
    }

    // From here on the request has written. Every failure must RETHROW: the
    // savepoint unwinds on a throw and not on a returned tool error, and a
    // returned error would commit a half-started reconciliation AND free the
    // key for a retry that starts a second one.
    const started = await startReconciliation(
      ctx.companyId, bankAccountId, statementDate, statementBalance, ctx.userId,
    );

    const matchResult = autoMatch
      ? await autoMatchTransactions(ctx.companyId, bankAccountId, started.id)
      : null;

    // Re-read: startReconciliation computed the reconciled balance before any
    // matching, and completeReconciliation checks the CURRENT difference.
    const current = await getReconciliationById(ctx.companyId, started.id);
    const difference = current?.difference ?? started.difference;
    const balanced = Math.abs(difference) < BALANCED_TOLERANCE;
    const matchedCount = current?.matchedCount ?? matchResult?.matched ?? 0;

    // A session that matched NOTHING is trivially "balanced": startReconciliation
    // sets reconciled_balance to gl_balance, so an empty session shows a R0.00
    // difference before anything happens. Production holds exactly one such
    // completed reconciliation — R0.00 difference, zero matched transactions —
    // and in every list and report it is indistinguishable from one that
    // proved the whole account. Completing that is signing off on nothing.
    const provedSomething = matchedCount > 0;
    const completed = complete && balanced && provedSomething
      ? await completeReconciliation(ctx.companyId, started.id, ctx.userId)
      : null;

    return ok({
      dry_run: false,
      reconciliation_id: started.id,
      bank_account_id: bankAccountId,
      statement_date: statementDate,
      statement_balance: statementBalance,
      gl_balance: started.glBalance,
      reconciled_balance: completed?.reconciledBalance ?? current?.reconciledBalance ?? started.reconciledBalance,
      difference,
      balanced,
      status: completed?.status ?? current?.status ?? started.status,
      completed: completed !== null,
      auto_matched: matchResult?.matched ?? 0,
      matched_count: matchedCount,
      still_unmatched: matchResult?.unmatched ?? current?.unmatchedCount ?? 0,
      low_confidence_candidates: matchResult?.candidates.length ?? 0,
      skipped_raced: matchResult?.skippedRaced ?? 0,
      ...(complete && !balanced
        ? {
          note:
            `Not completed: the difference is R${difference.toFixed(2)} and completion requires `
            + 'exactly zero. The session is still in progress with its matches intact — allocate '
            + 'the outstanding transactions, or cancel_bank_reconciliation to release them.',
        }
        : complete && !provedSomething
          ? {
            note:
              'Not completed: the session matched no transactions. It shows a zero difference '
              + 'only because a reconciliation starts at the GL balance, so an empty session '
              + 'balances trivially and would prove nothing. Allocate or import the '
              + 'transactions first, or cancel_bank_reconciliation to release the session.',
          }
          : {}),
    });
  },
};
