/**
 * MCP write tools: GL journals. create_draft_journal creates an UNPOSTED
 * entry; post_journal posts an existing draft and additionally requires the
 * write:post scope. Both call the same services the UI uses; companyId +
 * userId come from ctx ONLY.
 */
import type { McpTool } from '../types';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { mcpPostingAgent } from '../postingAgent';
import { guardCastableArgs, guardUuidList, ok, safeErrorText, strArg, toolError } from './toolHelpers';

function parseLines(raw: unknown): JournalLineInput[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: JournalLineInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const glAccountId = typeof o.account_id === 'string' ? o.account_id : '';
    const debit = Number(o.debit ?? 0);
    const credit = Number(o.credit ?? 0);
    if (!glAccountId || !Number.isFinite(debit) || !Number.isFinite(credit)) return null;
    lines.push({
      glAccountId,
      debit,
      credit,
      description: typeof o.description === 'string' ? o.description : undefined,
    });
  }
  return lines;
}

export const createDraftJournalTool: McpTool = {
  name: 'create_draft_journal',
  description:
    'Create an UNPOSTED (draft) GL journal entry. Lines use account_id (GL account UUID) with debit/credit amounts; total debits must equal total credits. Does not post — use post_journal (needs write:post) to post.',
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
          },
          required: ['account_id'],
          additionalProperties: false,
        },
      },
      idempotency_key: { type: 'string' },
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
    if (!lines) return toolError('lines must be a non-empty array of {account_id, debit, credit}');
    // accountsBelongToCompany casts every one of these to ::UUID, so a typo
    // there fails the ownership check itself rather than the posting.
    const badLine = guardUuidList(lines.map((l) => l.glAccountId), 'lines[].account_id');
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
        { postingAgent: mcpPostingAgent('create_draft_journal') },
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
    },
    required: ['journal_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const journalId = strArg(args, 'journal_id');
    if (!journalId) return toolError('journal_id is required');
    const bad = guardCastableArgs(args, { uuid: ['journal_id'] });
    if (bad) return bad;
    try {
      const entry = await postJournalEntry(ctx.companyId, journalId, ctx.userId);
      return ok(entry);
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to post journal.'));
    }
  },
};
