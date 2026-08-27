import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/agentActivityService', () => ({
  listAgentPostings: vi.fn(),
}));

import { listAgentPostings } from '@/modules/accounting/services/bank/agentActivityService';
import { listAgentPostingsTool } from '@/lib/mcp/tools/agentActivity';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;

beforeEach(() => vi.clearAllMocks());

describe('list_agent_postings', () => {
  it('is read-only — reviewing agent work must never need write scope', () => {
    expect(listAgentPostingsTool.write).toBe(false);
    expect(listAgentPostingsTool.requiresPost).toBeUndefined();
    expect(listAgentPostingsTool.scope).toBe('read:reports');
  });

  it('passes the tenant from ctx, the requested range, and defaults the limit to 50', async () => {
    vi.mocked(listAgentPostings).mockResolvedValue([]);

    await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31' }, ctx);

    expect(listAgentPostings).toHaveBeenCalledWith('company-1', '2026-08-01', '2026-08-31', 50);
  });

  it('caps an oversized limit at 100 — an unbounded result set can blow the agent context window', async () => {
    vi.mocked(listAgentPostings).mockResolvedValue([]);

    await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31', limit: 9999 }, ctx);

    expect(listAgentPostings).toHaveBeenCalledWith('company-1', '2026-08-01', '2026-08-31', 100);
  });

  it('rejects a missing range rather than scanning the whole ledger', async () => {
    const res = await listAgentPostingsTool.handler({ from: '2026-08-01' }, ctx);

    expect(res.isError).toBe(true);
    expect(listAgentPostings).not.toHaveBeenCalled();
  });

  // ── Finding 2 ────────────────────────────────────────────────────────────
  // The documented rollback is "list postings, then reverse each". Reversal
  // does not flip status, so unless the payload distinguishes live from
  // already-corrected the reviewer re-reverses and the call throws.
  it('surfaces the reversed flag in the payload so a reviewer can skip what is already corrected', async () => {
    vi.mocked(listAgentPostings).mockResolvedValue([
      {
        journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', entryNumber: 'JE-1', entryDate: '2026-08-04',
        description: 'live', postingAgent: 'mcp:allocate_bank_transaction:v1',
        status: 'posted', reversed: false, reversalOfId: null, amount: 100,
      },
      {
        journalEntryId: 'je-2', entryNumber: 'JE-2', entryDate: '2026-08-04',
        description: 'already corrected', postingAgent: 'mcp:allocate_bank_transaction:v1',
        status: 'posted', reversed: true, reversalOfId: null, amount: 250,
      },
    ]);

    const res = await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31' }, ctx);

    const payload = JSON.parse(res.content[0]!.text) as {
      postings: { journalEntryId: string; reversed: boolean }[];
    };
    expect(payload.postings.map((p) => p.reversed)).toEqual([false, true]);
  });

  it('tells the agent in its description that status does not signal reversal', () => {
    expect(listAgentPostingsTool.description).toMatch(/reversed/i);
  });

  // ── Finding 5: the description was not true of what the query returns ─────
  // It said "every journal entry this connector posted". The query filters
  // posting_agent LIKE 'mcp:%' company-wide (any connection), matches on
  // entry_date rather than when the tool ran, and — now that
  // create_draft_journal stamps too — returns UNPOSTED drafts as well. An
  // agent trusting the old wording would read an empty page as "the agent did
  // nothing", or a draft as a posted entry.
  it('describes the actual population: entry date, drafts included, company-wide', () => {
    const d = listAgentPostingsTool.description;

    expect(d).toMatch(/entry date/i);
    expect(d).toMatch(/draft/i);
    expect(d).toMatch(/limit|max/i);
    expect(d).not.toMatch(/every journal entry this connector posted/i);
  });

  // The catch path an agent hits when the range is malformed at the DB level.
  it('turns a service rejection into an isError result rather than throwing', async () => {
    vi.mocked(listAgentPostings).mockRejectedValue(new Error('invalid date range'));

    const res = await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31' }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('invalid date range');
  });

  it('generic-ifies a pg driver error — no schema names, no SQLSTATE, no stack', async () => {
    vi.mocked(listAgentPostings).mockRejectedValue(
      Object.assign(new Error('column je.posting_agentx does not exist'), { code: '42703' }),
    );

    const res = await listAgentPostingsTool.handler({ from: '2026-08-01', to: '2026-08-31' }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content[0]!.text;
    expect(text).toBe('Failed to list agent postings.');
    expect(text).not.toContain('posting_agentx');
    expect(text).not.toContain('column');
    expect(text).not.toContain('42703');
  });
});
