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
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const IF_THIS_IS_WRONG = [
  'If the two accounts are not in fact the same control account, this merge fuses two different',
  'populations into one balance and there is no record of which lines came from where beyond the',
  'journal ids listed above — the source account is deactivated carrying zero, so the split cannot',
  'be read back off the chart. Every per-account report, every comparative, the subledger',
  'reconciliation and any aged report grouped by control account change for every period the',
  'moved lines touch, including periods already reported on. The company trial balance does not',
  'change, so nothing about a balanced trial balance will tell you this went wrong.',
  'Reversing it means merging back, which is a second correction, not an undo.',
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
  'Does NOT cover: configuration rows (repoint them yourself first), renaming or renumbering the',
  'chart, and it never merges across companies. It is not an undo — reversing a merge means',
  'merging back, which is a second correction.',
].join(' ');

export const mergeGlAccountsTool: McpTool = {
  name: 'merge_gl_accounts',
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
    const result = await mergeAccounts(ctx.companyId, sourceId, targetId);
    return ok({ ...result, ifThisIsWrong: IF_THIS_IS_WRONG });
  },
};
