/**
 * The test this workstream exists for: a posting made through an MCP tool must
 * be distinguishable from one made through the UI.
 *
 * Today 4,948 of Brightsphere's 4,949 journal entries carry the same
 * created_by, and 2,589 of them are stamped `human:<userId>` by
 * defaultHumanMeta because the caller omitted the meta — so a `human:` stamp
 * proves nothing. Migration 530 added actor_type / actor_token_jti and nothing
 * wrote them. These tests fail if that propagation is ever removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: vi.fn(),
  getJournalEntryById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/neon', async () => {
  const original = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlFn = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...original, sql: sqlFn };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { createDraftJournalTool } from '@/lib/mcp/tools/writeJournals';
import { mcpPostingOpts } from '@/lib/mcp/mcpActor';
import { actorMeta, defaultHumanMeta } from '@/modules/accounting/services/gl/journalEntryMeta';

const ctx = {
  companyId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  scopes: ['write:journals'],
  tokenJti: 'tok-abc',
  oauthAppId: null,
} as never;

const LINES = [
  { account_id: '22222222-2222-4222-8222-222222222222', debit: 100, credit: 0 },
  { account_id: '33333333-3333-4333-8333-333333333333', debit: 0, credit: 100 },
];

beforeEach(() => vi.clearAllMocks());

describe('MCP write paths record the actor', () => {
  it('stamps create_draft_journal as an agent AND names the token that made it', async () => {
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1' } as never);

    await createDraftJournalTool.handler(
      { date: '2026-09-03', lines: LINES, idempotency_key: 'k1' },
      ctx,
    );

    const meta = vi.mocked(createJournalEntry).mock.calls[0]![3];
    expect(meta).toMatchObject({
      postingAgent: 'mcp:create_draft_journal:v1',
      actorType: 'agent',
      actorTokenJti: 'tok-abc',
    });
  });

  it('mcpPostingOpts derives every field from ctx — never from tool args', () => {
    const opts = mcpPostingOpts(ctx, 'allocate_bank_transaction');
    expect(opts).toEqual({
      postingAgent: 'mcp:allocate_bank_transaction:v1',
      actorType: 'agent',
      actorTokenJti: 'tok-abc',
    });
  });

  it('a PAT with no jti still records agent — the actor type does not depend on the token id', () => {
    const opts = mcpPostingOpts({ ...(ctx as object), tokenJti: null } as never, 'post_journal');
    expect(opts.actorType).toBe('agent');
    expect(opts.actorTokenJti).toBeNull();
  });
});

describe('the UI path records NOTHING rather than an unprovable human', () => {
  // This is the asymmetry the whole endpoint turns on. defaultHumanMeta is the
  // FALLBACK when a caller omits the meta — including agent callers that
  // forget. Writing actor_type 'human' there would convert an inference that
  // audit_trail can flag as derived into a recorded fact that it cannot.
  it('defaultHumanMeta sets no actor_type', () => {
    expect(defaultHumanMeta('user-1')).toEqual({ postingAgent: 'human:user-1' });
    expect(defaultHumanMeta('user-1')).not.toHaveProperty('actorType');
  });

  it('actorMeta returns undefined when no posting agent was declared', () => {
    expect(actorMeta(undefined)).toBeUndefined();
    expect(actorMeta({})).toBeUndefined();
  });

  it('actorMeta carries the actor through when one was declared', () => {
    expect(actorMeta({ postingAgent: 'mcp:x:v1', actorType: 'agent', actorTokenJti: 't' })).toEqual({
      postingAgent: 'mcp:x:v1',
      actorType: 'agent',
      actorTokenJti: 't',
    });
  });
});

// ── Documents, not just journals ──────────────────────────────────────────
// Migration 531's argument: create_credit_note writes a DRAFT row and no
// journal until approval, so for the whole draft period the posting_agent on a
// journal that does not exist yet is the only trace of who raised it. A credit
// note is the instrument that reduces a customer's debt.
// Document attribution is proven with real cookie/PAT/OAuth rows in arCiActor.int.test.ts.
describe('draft credit-note authority',()=>{
 it('requires an issued context before any draft insert',async()=>{
  const {createCreditNote}=await import('@/modules/accounting/services/ar/creditNoteService');
  await expect(createCreditNote('11111111-1111-4111-8111-111111111111',{type:'customer',creditDate:'2026-07-05',subtotal:100},'22222222-2222-4222-8222-222222222222')).rejects.toThrow('Authenticated');
 });
});
