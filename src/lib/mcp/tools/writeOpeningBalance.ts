/**
 * MCP write tool: post a bank account's opening balance.
 *
 * Six Velocity Fibre paycards have genuine data gaps — history that was never
 * captured — and there was no clean way to say "this card started at R X on
 * this date". Everything had to be expressed as transactions, which means
 * inventing transactions that never happened.
 *
 * The obvious shortcut is wrong. `gl_accounts.bank_opening_balance` already
 * exists and is writable from the bank-account editor, but it is DISPLAY
 * METADATA: `getBankAccountsStatus` computes `balance` as `SUM(bt.amount)` and
 * never adds it. Setting that column alone would show the right number on the
 * banking screen while the trial balance, the balance sheet and every
 * reconciliation stayed wrong — the worst of both, because the screen a person
 * checks would agree with them.
 *
 * So this posts a real journal (source `auto_migration`) AND records the
 * metadata, so the two agree.
 *
 * `contra_account_id` is REQUIRED and deliberately not defaulted. Where the
 * other side of an opening balance belongs — an opening-balance equity
 * account, retained earnings, or a suspense account cleared later — is a
 * policy decision that differs per firm and lands in equity. An agent picking
 * it silently would be making that call for the accountant.
 */
import type { McpTool } from '../types';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { accountsBelongToCompany, getAccountById } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { setBankOpeningBalanceMeta } from '@/modules/accounting/services/bank/bankOpeningBalanceService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'set_opening_balance';

export const setOpeningBalanceTool: McpTool = {
  name: TOOL,
  description:
    'Post an opening balance for a bank account so it reconciles from a known starting point — for a card or account whose earlier history was never captured. ' +
    'Posts a real journal dated as_at (DR the bank account and CR the contra for a positive amount, reversed for a negative one) and records the figure on the account so the banking screens agree with the ledger. ' +
    'contra_account_id is REQUIRED and has no default: where the other side belongs (opening-balance equity, retained earnings, a suspense account) is your firm\'s decision, and it lands in equity. ' +
    'Refuses if the account already has an opening balance — reverse that journal first rather than stacking a second one. Requires the write:post permission.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: { type: 'string', description: 'The bank GL account UUID' },
      as_at: {
        type: 'string',
        format: 'date',
        description: 'The date the balance is stated as at. The journal carries this date, so its fiscal period must exist and be open.',
      },
      amount: {
        type: 'number',
        description: 'The balance as at that date. Negative for an overdrawn account. Zero is refused — it would post nothing and tell you it succeeded.',
      },
      contra_account_id: {
        type: 'string',
        description: 'The other side of the entry. Usually an opening-balance equity or suspense account. No default.',
      },
      memo: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['bank_account_id', 'as_at', 'amount', 'contra_account_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const contraAccountId = strArg(args, 'contra_account_id');
    const asAt = strArg(args, 'as_at');
    if (!bankAccountId) return toolError('bank_account_id is required');
    if (!contraAccountId) return toolError('contra_account_id is required');
    if (!asAt) return toolError('as_at is required (YYYY-MM-DD)');

    const bad = guardCastableArgs(args, {
      uuid: ['bank_account_id', 'contra_account_id'],
      date: ['as_at'],
    });
    if (bad) return bad;

    const amount = Number(args.amount);
    if (!Number.isFinite(amount)) return toolError('amount must be a number');
    // A zero opening balance posts a journal with two zero lines: it balances,
    // it commits, and it changes nothing — while marking the account as having
    // an opening balance, which then blocks the real one.
    if (amount === 0) {
      return toolError('amount must not be zero — there is nothing to post.');
    }
    if (bankAccountId === contraAccountId) {
      // Debiting and crediting the same account nets to nothing but still
      // balances, so nothing downstream would catch it.
      return toolError('contra_account_id must differ from bank_account_id');
    }

    // Ownership for both ids, batched, before any write. Neither the service
    // nor the database re-checks the tenant on these foreign keys.
    if (!(await accountsBelongToCompany(ctx.companyId, [bankAccountId, contraAccountId]))) {
      return toolError(NOT_FOUND);
    }

    const bankAccount = await getAccountById(ctx.companyId, bankAccountId);
    if (!bankAccount) return toolError(NOT_FOUND);
    if (bankAccount.accountSubtype !== 'bank') {
      // Stated plainly: this is the same NULL-subtype trap that makes an
      // account unable to receive a statement import, and the remedy is the
      // same call.
      return toolError(
        `${bankAccount.accountCode} is not a bank account (account_subtype is ` +
          `${bankAccount.accountSubtype ?? 'not set'}). Set it with update_gl_account first.`,
      );
    }

    // Refuse a second opening balance rather than stacking one. Two of these
    // both post, both balance, and the account is then wrong by exactly the
    // first amount with nothing flagging it.
    const existing = await setBankOpeningBalanceMeta.read(ctx.companyId, bankAccountId);
    if (existing.amount !== null && existing.amount !== 0) {
      return toolError(
        `${bankAccount.accountCode} already has an opening balance of ${existing.amount}` +
          `${existing.asAt ? ` as at ${existing.asAt}` : ''}. Reverse that journal before posting another.`,
      );
    }

    const amountAbs = Math.abs(Math.round(amount * 100) / 100);
    const bankIsDebit = amount > 0;
    const lines: JournalLineInput[] = [
      {
        glAccountId: bankAccountId,
        debit: bankIsDebit ? amountAbs : 0,
        credit: bankIsDebit ? 0 : amountAbs,
        description: `Opening balance as at ${asAt}`,
      },
      {
        glAccountId: contraAccountId,
        debit: bankIsDebit ? 0 : amountAbs,
        credit: bankIsDebit ? amountAbs : 0,
        description: `Opening balance — ${bankAccount.accountCode}`,
      },
    ];

    // No catch from here on. createJournalEntry validates the period and the
    // balance and refuses BEFORE writing, but postJournalEntry writes — and a
    // `catch → toolError` after that point is audited with a NULL idempotency
    // key, so the agent's retry would post a second opening balance.
    const entry = await createJournalEntry(
      ctx.companyId,
      {
        entryDate: asAt,
        description: strArg(args, 'memo') ?? `Opening balance — ${bankAccount.accountName}`,
        source: 'auto_migration',
        lines,
      },
      ctx.userId,
      { postingAgent: mcpPostingAgent(TOOL) },
    );
    await postJournalEntry(ctx.companyId, entry.id, ctx.userId);

    // Written AFTER the posting, so the metadata can never claim an opening
    // balance the ledger does not have. The reverse order would leave the
    // banking screen showing a figure a failed post never created.
    await setBankOpeningBalanceMeta.write(ctx.companyId, bankAccountId, amount, asAt);

    return ok({
      bank_account_id: bankAccountId,
      account_code: bankAccount.accountCode,
      as_at: asAt,
      amount,
      contra_account_id: contraAccountId,
      journal_entry_id: entry.id,
      posted: true,
    });
  },
};
