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
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { JournalLineInput, VatType } from '@/modules/accounting/types/gl.types';
import { mcpPostingOpts } from '../mcpActor';
import { ALLOW_LATE_INPUT_CLAIM_PROP, allowLateInputClaim } from './lateClaimArg';
import { NOT_FOUND, guardCastableArgs, guardUuidList, ok, safeErrorText, strArg, toolError } from './toolHelpers';

/**
 * The VAT treatments a manual line may carry — the same set an allocation
 * stamps on its lines (gl.types VatType). Without one, a manual line on a VAT
 * control account is an "uncoded GL VAT line" and BLOCKS the VAT201, so a
 * correcting journal that mirrors an allocation (e.g. moving a reversal into
 * the period it corrects) could never be filed. Opt-in per line: omitted, the
 * line stays uncoded exactly as before.
 */
export const JOURNAL_LINE_VAT_TYPES: readonly VatType[] = [
  'standard', 'zero_rated', 'exempt', 'capital_goods', 'export', 'imported', 'reverse_charge', 'bad_debt',
];

function parseLines(raw: unknown): JournalLineInput[] | string | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: JournalLineInput[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const glAccountId = typeof o.account_id === 'string' ? o.account_id : '';
    const debit = Number(o.debit ?? 0);
    const credit = Number(o.credit ?? 0);
    if (!glAccountId || !Number.isFinite(debit) || !Number.isFinite(credit)) return null;
    let vatType: VatType | undefined;
    if (o.vat_type !== undefined && o.vat_type !== null) {
      if (typeof o.vat_type !== 'string' || !(JOURNAL_LINE_VAT_TYPES as readonly string[]).includes(o.vat_type)) {
        return `lines[${i}].vat_type must be one of: ${JOURNAL_LINE_VAT_TYPES.join(', ')}`;
      }
      vatType = o.vat_type as VatType;
    }
    lines.push({
      glAccountId,
      debit,
      credit,
      description: typeof o.description === 'string' ? o.description : undefined,
      ...(vatType ? { vatType } : {}),
    });
  }
  return lines;
}

export const createDraftJournalTool: McpTool = {
  name: 'create_draft_journal',
  description:
    'Create an UNPOSTED (draft) GL journal entry. Lines use account_id (GL account UUID) with debit/credit amounts; total debits must equal total credits. A line may carry vat_type (standard, zero_rated, exempt, …) so a correcting journal on VAT Input/Output is coded for the VAT201 like an allocation. Does not post — use post_journal (needs write:post) to post.',
  scope: 'write:journals',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', format: 'date', description: 'Entry date, YYYY-MM-DD' },
      memo: { type: 'string', description: 'Entry description' },
      lines: {
        type: 'array',
        minItems: 2,
        items: {
          type: 'object',
          properties: {
            account_id: { type: 'string', description: 'GL account UUID' },
            debit: { type: 'number', minimum: 0 },
            credit: { type: 'number', minimum: 0 },
            description: { type: 'string' },
            vat_type: {
              type: 'string',
              enum: [...JOURNAL_LINE_VAT_TYPES],
              description:
                'VAT treatment of this line, as an allocation would stamp it. Set it on a VAT Input/'
                + 'Output line AND on the base line it belongs to; a VAT-account line without it is '
                + 'reported by vat_exceptions as uncoded and blocks the VAT201. Omit for non-VAT lines.',
            },
          },
          required: ['account_id'],
          additionalProperties: false,
        },
      },
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
    const lines = parseLines(args.lines);
    if (typeof lines === 'string') return toolError(lines);
    if (!lines) return toolError('lines must be a non-empty array of {account_id, debit, credit}');
    // accountsBelongToCompany casts every one of these to ::UUID, so a typo
    // there fails the ownership check itself rather than the posting.
    const badLine = guardUuidList(lines.map((l) => l.glAccountId), (i) => `lines[${i}].account_id`);
    if (badLine) return badLine;
    // Ownership: every line's GL account must belong to the token's company —
    // a foreign account_id would book cross-company (and silently unbalance
    // this company's own trial balance via the RLS-hidden joined row).
    if (!(await accountsBelongToCompany(ctx.companyId, lines.map((l) => l.glAccountId)))) {
      return toolError('One or more account_id values are not GL accounts in your company.');
    }
    try {
      // Stamp the agent. Without meta, createJournalEntry falls back to
      // defaultHumanMeta(userId) and the entry lands as human:<userId> — agent
      // work affirmatively labelled as the token owner's own work, and
      // invisible to list_agent_postings (which filters posting_agent LIKE
      // 'mcp:%'). Drafts count: post_journal does not restamp, so an unstamped
      // draft stays mislabelled after it is posted.
      const entry = await createJournalEntry(
        ctx.companyId,
        { entryDate, description: strArg(args, 'memo'), lines },
        ctx.userId,
        mcpPostingOpts(ctx, 'create_draft_journal'),
        { allowLateInputClaim: allowLateInputClaim(args) },
      );
      return ok(entry);
    } catch (err) {
      // Balance/period validation errors (plain Errors) are safe to surface;
      // pg errors (with a SQLSTATE code) are generic-ified to avoid leaking schema.
      return toolError(safeErrorText(err, 'Failed to create journal (check it balances and the date is in an open period).'));
    }
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

    // No catch: a closed period, an unbalanced entry or a database failure must
    // reach the registry's savepoint rather than being flattened into a tool
    // error that keeps whatever was written.
    // The result carries `lateClaim` when the VAT was claimed late.
    return ok(await postJournalEntry(ctx.companyId, journalId, ctx.userId,
      { allowLateInputClaim: allowLateInputClaim(args) }));
  },
};
