/**
 * MCP write tool: `merge_gl_accounts`.
 *
 * A WRAP of `gl/accountMergeService`. The tool writes no SQL and makes no
 * accounting decision; what it owns is the safety envelope — ownership answered
 * from a read, every refusal raised BEFORE the service that can write is
 * called, and a dry run that frees the idempotency key.
 *
 * The dry run is the point of this tool. Merging two control accounts is a
 * production data correction and a human decision, so the preview is built to
 * be read and signed off, not to be skimmed by an agent on its way to writing.
 *
 * Ordering matters and is not stylistic. `previewAccountMerge` re-runs every
 * request-level guard and writes nothing, so a refusal reaches the agent from
 * inside a `catch` here with nothing to unwind. `mergeAccounts` is then called
 * with NO catch: it can write, and the registry's savepoint rolls back on a
 * THROW and not on a returned `toolError`. A write-then-toolError handler would
 * commit the partial write and free the key for a retry that writes again.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA } from '@/lib/mcp/contracts';
import { getAccountById } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { previewAccountMerge } from '@/modules/accounting/services/gl/accountMergePreview';
import {
  AccountMergeError,
  mergeAccounts,
} from '@/modules/accounting/services/gl/accountMergeService';
import { lockGlAccountsForUpdate } from '@/modules/accounting/services/gl/glAccountLock';
import { mcpPostingOpts } from '../mcpActor';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'merge_gl_accounts';

const IF_THIS_IS_WRONG = [
  'If the two accounts are not in fact the same control account, this merge fuses two different',
  'populations into one balance and there is no record of which lines came from where beyond the',
  'journal ids listed above — the source account is deactivated carrying zero, so the split cannot',
  'be read back off the chart. Every per-account report, every comparative, the subledger',
  'reconciliation and any aged report grouped by control account change for every period the',
  'moved lines touch, including periods already reported on. The company trial balance does not',
  'change, so nothing about a balanced trial balance will tell you this went wrong.',
  'Reversing it means merging back, which is a second correction, not an undo — a reverse merge',
  'carries the target\'s ORIGINAL lines with it, so the two populations stay fused. What makes a',
  'wrong merge recoverable is the gl_account_merges record: it names every line that moved, and',
  'movedLinesDigest lets you check the merge that ran is the one you signed.',
].join(' ');

const DESCRIPTION = [
  'Merge one GL account into another: every journal line on the source is repointed to the target,',
  'the source\'s child accounts are moved onto the target with their levels shifted, and the source',
  'is DEACTIVATED carrying zero. Nothing is deleted and no journal is posted — a repoint changes no',
  'debit and no credit, only which account carries it, so the company trial balance is identical',
  'afterwards. Per-account balances, comparatives and any report grouped by account DO change, for',
  'every period the moved lines touch.',
  'Built for a chart that carries two control accounts for one role — a Sage-imported account',
  'holding the old population beside the one the write path actually posts to. There is no',
  'canonical control account in this schema and the codes differ per company, so this tool takes',
  'both accounts by id and forms no opinion about which is canonical.',
  'RUN dry_run FIRST and read it. It returns both accounts\' figures derived by separate queries,',
  'the trial balance either side of the move, the journal entries as ids you can open, every row',
  'that would not move with a reason code, the child accounts that would be reparented, and what',
  'breaks if the proposal is wrong. It writes nothing.',
  'REFUSES: the same account twice; two different account_types; a target sitting below the source',
  'in the chart (a cycle); a SYSTEM account as the source, because auto-posting resolves those by',
  'subtype and deactivating one leaves the role unclaimed; a bank-subtype source that bank',
  'transactions still reference; and a source any configuration row still names (bank rules, AFS',
  'mappings, asset categories, products — the check is driven by the foreign-key catalogue, so it',
  'covers tables added after this tool was written).',
  'SKIPS BLOCK THE MERGE: a posted line in a closed fiscal period, or a posted line with no fiscal',
  'period at all, is reported with its amount and the whole merge refuses. A control-account merge',
  'that leaves part of its balance behind is worse than one that does not run.',
  'ALSO REFUSES a merge that crosses a REPORTING CLASS: vat (subtypes vat_input, vat_output, tax —',
  'what the VAT201 selects on) and bank (what the banking screens reach statement rows through)',
  'are each their own class, and everything else including NULL is ordinary. Crossing that',
  'boundary puts money that is not tax onto a SARS return in one direction and drops it off in the',
  'other, with the trial balance identical either way. Same-class merges are allowed, so the two',
  'control-account cases this tool was built for (NULL to receivable, NULL to payable) pass.',
  'Does NOT cover: configuration rows (repoint them yourself first) — and note that the',
  'configuration sweep reads foreign keys, so a reference held BY ACCOUNT CODE rather than by id',
  'is invisible to it. group_accounts.account_code is the known case: the consolidation chart',
  'resolves by code, the source keeps its code after the merge, so the group mapping goes on',
  'resolving to an account that now carries zero while the money joins the target\'s',
  'consolidation line. Check it by hand before merging an account that is in a group.',
  'It also does not rename or renumber the chart, and never merges across companies.',
  'CONCURRENCY: the live call locks both accounts for the rest of the request. If another request '
  + 'holds one, this waits 5 seconds and then refuses with a message saying to retry — that one is '
  + 'safe to re-issue with the same idempotency_key, because nothing was written. One failure mode '
  + 'is NOT specific: if the ledger changes between the preview and the write (a journal posted, a '
  + 'period closed), the merge aborts having written nothing, but reaches you as a generic failure '
  + 'rather than a named one. Re-run with dry_run to see what moved.',
].join(' ');

export const mergeGlAccountsTool: McpTool = {
  name: TOOL,
  description: DESCRIPTION,
  scope: 'write:accounts',
  write: true,
  // It rewrites POSTED journal lines. It posts no journal, but `write:post` is
  // the scope that gates changing what is in the ledger, and this changes it
  // for potentially thousands of lines at once.
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      source_account_id: {
        type: 'string',
        description: 'The account to merge AWAY. It ends up deactivated with a zero balance. From list_gl_accounts.',
      },
      target_account_id: {
        type: 'string',
        description: 'The account that keeps the balance and receives the journal lines and child accounts.',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['source_account_id', 'target_account_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const sourceId = strArg(args, 'source_account_id');
    const targetId = strArg(args, 'target_account_id');
    if (!sourceId) return toolError('source_account_id is required');
    if (!targetId) return toolError('target_account_id is required');
    const bad = guardCastableArgs(args, { uuid: ['source_account_id', 'target_account_id'] });
    if (bad) return bad;

    // Ownership, answered from a READ before anything is written, with the same
    // text a genuine miss gets. Both ids become foreign keys, and the services
    // do not re-check the tenant.
    const [source, target] = await Promise.all([
      getAccountById(ctx.companyId, sourceId),
      getAccountById(ctx.companyId, targetId),
    ]);
    if (!source || !target) return toolError(NOT_FOUND);

    // On the LIVE path only, take the row lock here rather than leaving it to
    // the service. Two reasons, and the first is the one that matters:
    //
    //  - A lock timeout is then a genuine PRE-WRITE refusal and can be returned
    //    as a toolError carrying its own message. Left inside `mergeAccounts` —
    //    which is called uncaught, correctly — it would propagate to the
    //    registry and reach the agent as GENERIC_FAILURE, which tells it
    //    nothing and in particular does not tell it to retry. This is the
    //    `writeJournalReverse` pattern: answer every refusal you can from
    //    before the first write, so the writing call needs no catch.
    //  - The preview below then reads under the lock, so what the live call
    //    checks cannot change between the check and the write.
    //
    // A DRY RUN takes no lock. It writes nothing and must not hold rows for the
    // rest of the request against everyone else.
    //
    // `mergeAccounts` locks again for its own non-MCP callers; re-locking rows
    // this transaction already holds is free.
    if (args.dry_run !== true) {
      try {
        await lockGlAccountsForUpdate(ctx.companyId, [sourceId, targetId]);
      } catch (err) {
        // By code, not instanceof: the code is the stable half of that contract
        // (`bulkAllocationPost` reads BANK_TX_LOCK_TIMEOUT the same way).
        // Write-free by construction — this is the first statement of the write
        // path, so there is nothing to unwind.
        if ((err as { code?: unknown }).code === 'GL_ACCOUNT_LOCK_TIMEOUT') {
          return toolError((err as Error).message);
        }
        throw err;
      }
    }

    // Writes nothing, and re-runs every request-level guard, so a refusal here
    // is answered with nothing to unwind.
    let preview;
    try {
      preview = await previewAccountMerge(ctx.companyId, sourceId, targetId);
    } catch (err) {
      if (err instanceof AccountMergeError) return toolError(err.message);
      throw err;
    }

    if (args.dry_run === true) {
      // wroteNothing keeps the idempotency key free — without it the real call
      // that follows, carrying the same intent and key, is served this preview
      // forever.
      return {
        ...ok({ dryRun: true, ...preview, ifThisIsWrong: IF_THIS_IS_WRONG }),
        wroteNothing: true,
      };
    }

    // The same row-state guard the dry run reported. A live call that went ahead
    // where the preview said `blocked` would make the dry run a lie.
    if (preview.blocked) {
      return toolError(
        `${preview.skipsTotal} journal line${preview.skipsTotal === 1 ? '' : 's'} on `
        + `${preview.source.accountCode} cannot be repointed (`
        + `${[...new Set(preview.skips.map((s) => s.reason))].join(', ')}). `
        + 'Nothing has been changed. Run this tool with dry_run to see the entries.',
      );
    }

    // Nothing below is caught: mergeAccounts can write, and the savepoint only
    // unwinds on a throw.
    const actor = mcpPostingOpts(ctx, TOOL);
    const result = await mergeAccounts(ctx.companyId, sourceId, targetId, ctx.userId, actor);
    return ok({ ...result, ifThisIsWrong: IF_THIS_IS_WRONG });
  },
};
