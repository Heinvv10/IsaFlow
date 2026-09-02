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
 * `contra_account_id` defaults to the company's Opening Balance Equity
 * account (created on first use — see openingBalanceEquityService for why
 * that, and not retained earnings). An explicit id still overrides it for a
 * firm whose policy is retained earnings or a suspense account. The reply
 * names the account actually used either way, so the choice is never silent.
 */
import type { McpTool } from '../types';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { accountsBelongToCompany, getAccountById } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { setBankOpeningBalanceMeta } from '@/modules/accounting/services/bank/bankOpeningBalanceService';
import { ensureOpeningBalanceEquityAccount } from '@/modules/accounting/services/gl/openingBalanceEquityService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'set_opening_balance';

export const setOpeningBalanceTool: McpTool = {
  name: TOOL,
  description:
    'Post an opening balance for a bank account so it reconciles from a known starting point — for a card or account whose earlier history was never captured. ' +
    'Posts a real journal dated as_at (DR the bank account and CR the contra for a positive amount, reversed for a negative one) and records the figure on the account so the banking screens agree with the ledger. ' +
    'contra_account_id is optional: omitted, the other side posts to the company\'s Opening Balance Equity clearing account (created on first use), which should net to zero once every opening balance is captured — the close-readiness checklist warns while it does not. Pass an explicit contra_account_id (retained earnings, a suspense account) only when the firm\'s policy says so. The reply carries the contra actually used. ' +
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
        description: 'Optional. The other side of the entry. Defaults to the company\'s Opening Balance Equity account.',
      },
      memo: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['bank_account_id', 'as_at', 'amount', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bankAccountId = strArg(args, 'bank_account_id');
    const explicitContra = strArg(args, 'contra_account_id');
    const asAt = strArg(args, 'as_at');
    if (!bankAccountId) return toolError('bank_account_id is required');
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
    if (bankAccountId === explicitContra) {
      // Debiting and crediting the same account nets to nothing but still
      // balances, so nothing downstream would catch it.
      return toolError('contra_account_id must differ from bank_account_id');
    }

    // Ownership for every agent-supplied id, batched, before any write.
    // Neither the service nor the database re-checks the tenant on these
    // foreign keys. The default contra is resolved by ctx.companyId and needs
    // no check — but it is resolved AFTER the ownership and state refusals
    // below, so a refused call never creates the account as a side effect.
    const owned = explicitContra ? [bankAccountId, explicitContra] : [bankAccountId];
    if (!(await accountsBelongToCompany(ctx.companyId, owned))) {
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

    // Creating the clearing account is the one write that precedes the
    // journal. It is idempotent (find-or-create on a reserved subtype), so a
    // retry after a later failure finds the same account rather than a second.
    const contra = explicitContra
      ? { id: explicitContra, created: false }
      : await ensureOpeningBalanceEquityAccount(ctx.companyId);
    const contraAccountId = contra.id;

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
      contra_defaulted: !explicitContra,
      contra_account_created: contra.created,
      journal_entry_id: entry.id,
      posted: true,
    });
  },
};
