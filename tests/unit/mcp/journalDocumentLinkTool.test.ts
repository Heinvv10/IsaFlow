/**
 * link_document_to_journal — dry_run preview, link/unlink dispatch, and a
 * refusal surfacing as a toolError before any write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  linkDocumentToJournal: vi.fn(),
  unlinkDocumentFromJournal: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalDocumentLinkService', () => {
  class JournalDocumentLinkRefusal extends Error {}
  return {
    linkDocumentToJournal: m.linkDocumentToJournal,
    unlinkDocumentFromJournal: m.unlinkDocumentFromJournal,
    JournalDocumentLinkRefusal,
  };
});

import { linkDocumentToJournalTool } from '@/lib/mcp/tools/journalDocumentLink';
import { JournalDocumentLinkRefusal } from '@/modules/accounting/services/gl/journalDocumentLinkService';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const JOURNAL = 'cccccccc-0000-4000-8000-cccccccccccc';
const DOC = 'dddddddd-0000-4000-8000-dddddddddddd';
const ctx: McpToolContext = { userId: USER, companyId: COMPANY, scopes: ['write:journals', 'write:post'], tokenJti: 'tok-1', oauthAppId: null };
const args = { action: 'link', journal_entry_id: JOURNAL, captured_document_id: DOC, reason: 'Invoice attached', idempotency_key: 'k-1' };

function text(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.linkDocumentToJournal.mockResolvedValue({ id: 'link-1', journalEntryId: JOURNAL, capturedDocumentId: DOC });
  m.unlinkDocumentFromJournal.mockResolvedValue(undefined);
});

it('dry_run previews without calling the service', async () => {
  const result = await linkDocumentToJournalTool.handler({ ...args, dry_run: true }, ctx);
  expect(text(result).dryRun).toBe(true);
  expect(m.linkDocumentToJournal).not.toHaveBeenCalled();
});

it('link calls linkDocumentToJournal with the authenticated user', async () => {
  await linkDocumentToJournalTool.handler(args, ctx);
  expect(m.linkDocumentToJournal).toHaveBeenCalledWith(COMPANY, JOURNAL, DOC, USER, 'Invoice attached');
});

it('unlink calls unlinkDocumentFromJournal', async () => {
  await linkDocumentToJournalTool.handler({ ...args, action: 'unlink' }, ctx);
  expect(m.unlinkDocumentFromJournal).toHaveBeenCalledWith(COMPANY, JOURNAL, DOC, USER, 'Invoice attached');
  expect(m.linkDocumentToJournal).not.toHaveBeenCalled();
});

it('returns a toolError, not a throw, for a service refusal', async () => {
  m.linkDocumentToJournal.mockRejectedValue(new JournalDocumentLinkRefusal('Captured document not found.'));
  const result = await linkDocumentToJournalTool.handler(args, ctx);
  expect(result.isError).toBe(true);
});

it('refuses a missing reason before any write', async () => {
  const { reason: _drop, ...noReason } = args;
  const result = await linkDocumentToJournalTool.handler(noReason, ctx);
  expect(result.isError).toBe(true);
  expect(m.linkDocumentToJournal).not.toHaveBeenCalled();
});

it('refuses an invalid journal_entry_id before any write', async () => {
  const result = await linkDocumentToJournalTool.handler({ ...args, journal_entry_id: 'not-a-uuid' }, ctx);
  expect(result.isError).toBe(true);
  expect(m.linkDocumentToJournal).not.toHaveBeenCalled();
});
