/**
 * MCP write tools: GL journals. create_draft_journal creates an UNPOSTED
 * entry; post_journal posts an existing draft and additionally requires the
 * write:post scope. Both call the same services the UI uses; companyId +
 * userId come from ctx ONLY.
 */
import type { McpTool } from '../types';
import { createJournalEntry, getJournalEntryById } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { journalVatRefusal } from '@/modules/accounting/services/capture/capturedVatEvidence';
import {
  agentManualJournalRefusal, lockManualJournalIfEnforced, markCreatedManualJournal, markManualJournal,
} from '@/modules/accounting/services/gl/manualJournalApproval';
import { mcpPostingOpts } from '../mcpActor';
import { ALLOW_LATE_INPUT_CLAIM_PROP, allowLateInputClaim } from './lateClaimArg';
import { NOT_FOUND, guardCastableArgs, ok, safeErrorText, strArg, toolError } from './toolHelpers';
import { JOURNAL_LINE_ITEM_SCHEMA, checkJournalLines } from './journalLineArgs';
import { EXTERNAL_REF_CREATE_PROPS, createReplayOrLock, parseCreateRef, stampCreated } from './externalRef';

export { JOURNAL_LINE_VAT_TYPES } from './journalLineArgs';

export const createDraftJournalTool: McpTool = {
  name: 'create_draft_journal',
  description:
    'Create an UNPOSTED (draft) GL journal entry. Lines use account_id (GL account UUID) with debit/credit amounts; total debits must equal total credits. A line may carry vat_type (standard, zero_rated, exempt, …) so a correcting journal on VAT Input/Output is coded for the VAT201 like an allocation. Does not post — use post_journal (needs write:post) to post. '
    + 'Pass external_system + external_ref (e.g. the Sage journal id) to make the create idempotent: a live (unreversed) journal already carrying them is returned instead (already_existed: true).',
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', format: 'date', description: 'Entry date, YYYY-MM-DD' },
      memo: { type: 'string', description: 'Entry description' },
      lines: { type: 'array', minItems: 2, items: JOURNAL_LINE_ITEM_SCHEMA },
      ...EXTERNAL_REF_CREATE_PROPS,
      idempotency_key: { type: 'string' },
      allow_late_input_claim: ALLOW_LATE_INPUT_CLAIM_PROP,
    },
    required: ['date', 'lines', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const entryDate = strArg(args, 'date');
    if (!entryDate) return toolError('date is required (YYYY-MM-DD)');
    const badDate = guardCastableArgs(args, { date: ['date'] });
    if (badDate) return badDate;
    const xref = parseCreateRef(args);
    if (typeof xref === 'string') return toolError(xref);
    const checked = await checkJournalLines(ctx, args.lines, 'create_draft_journal');
    if (typeof checked === 'string') return toolError(checked);
    const { lines, warnings } = checked;
    const replay = await createReplayOrLock(ctx, 'journal', xref, { expect: { date: entryDate } });
    if (replay) return replay;
    let entry: Awaited<ReturnType<typeof createJournalEntry>>;
    try {
      // Stamp the agent. Without meta, createJournalEntry falls back to
      // defaultHumanMeta(userId) and the entry lands as human:<userId> — agent
      // work affirmatively labelled as the token owner's own work, and
      // invisible to list_agent_postings (which filters posting_agent LIKE
      // 'mcp:%'). Drafts count: post_journal does not restamp, so an unstamped
      // draft stays mislabelled after it is posted.
      entry = await createJournalEntry(
        ctx.companyId,
        { entryDate, description: strArg(args, 'memo'), lines },
        ctx.userId,
        mcpPostingOpts(ctx, 'create_draft_journal'),
        { allowLateInputClaim: allowLateInputClaim(args) },
      );
    } catch (err) {
      // Balance/period validation errors (plain Errors) are safe to surface;
      // pg errors (with a SQLSTATE code) are generic-ified to avoid leaking schema.
      return toolError(safeErrorText(err, 'Failed to create journal (check it balances and the date is in an open period).'));
    }
    // R-035 PR6: an agent composed it — marked under manual-journal enforcement
    // (still only a draft). Outside the catch: a failure here must reach the
    // registry's savepoint, not commit an unmarked draft behind a tool error.
    await markCreatedManualJournal(ctx.companyId, entry.id);
    await stampCreated(ctx, 'journal', entry.id, xref);
    return ok({
      ...entry,
      ...(warnings.length > 0 ? { dimension_warnings: warnings } : {}),
      ...(xref ? { external_system: xref.system, external_ref: xref.ref } : {}),
    });
  },
};

export const postJournalTool: McpTool = {
  name: 'post_journal',
  description:
    'Post an existing DRAFT journal entry by id — irreversible. Requires the write:post permission.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      journal_id: { type: 'string' },
      idempotency_key: { type: 'string' },
      allow_late_input_claim: ALLOW_LATE_INPUT_CLAIM_PROP,
    },
    required: ['journal_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const journalId = strArg(args, 'journal_id');
    if (!journalId) return toolError('journal_id is required');
    const bad = guardCastableArgs(args, { uuid: ['journal_id'] });
    if (bad) return bad;
    // R-035 PR6: under manual-journal enforcement the draft is locked before
    // the reads below, so the approval read and the post see one state.
    const enforced = await lockManualJournalIfEnforced(ctx.companyId, journalId);
    // Pre-write refusals are answered from a READ, so the service call below
    // needs no catch. postJournalEntry raises the same two itself, but a
    // `catch → toolError` cannot tell them from a failure after the status
    // UPDATE landed — and a refusal is audited with a NULL idempotency key, so
    // the agent's retry on that key would run the post a second time.
    const entry = await getJournalEntryById(ctx.companyId, journalId);
    if (!entry) return toolError(NOT_FOUND);
    if (entry.status !== 'draft') {
      return toolError(`Cannot post entry with status: ${entry.status}`);
    }
    // K-072 r31–r36: a VAT the captured receipt never showed, or a held meals merchant's VAT, is not an agent's to post.
    const vatRefusal = await journalVatRefusal(ctx.companyId, journalId);
    if (vatRefusal) return toolError(`Cannot post entry: ${vatRefusal}.`);
    // R-035 PR6, decision Q6: an agent may neither raise nor decide an approval,
    // so a draft the gate does not clear is refused here, from the same read,
    // before anything is written — the key stays free for the call that
    // succeeds once a person has had it approved.
    const approvalRefusal = enforced ? await agentManualJournalRefusal(ctx.companyId, journalId) : null;
    if (approvalRefusal) return toolError(approvalRefusal);
    // Cleared: marked, so migration 869's backstop judges the flip below too.
    if (enforced) await markManualJournal(ctx.companyId, journalId);

    // No catch: a closed period, an unbalanced entry or a database failure must
    // reach the registry's savepoint rather than being flattened into a tool
    // error that keeps whatever was written.
    // The result carries `lateClaim` when the VAT was claimed late.
    return ok(await postJournalEntry(ctx.companyId, journalId, ctx.userId,
      { allowLateInputClaim: allowLateInputClaim(args) }));
  },
};
