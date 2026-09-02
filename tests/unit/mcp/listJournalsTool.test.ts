/**
 * MCP read tool `list_journals`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/journalEntryListService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/gl/journalEntryListService')>();
  return { ...real, listJournalEntriesPage: vi.fn() };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { InvalidCursorError } from '@/modules/accounting/services/bank/bankTxCursor';
import { listJournalEntriesPage } from '@/modules/accounting/services/gl/journalEntryListService';
import { listJournalsTool } from '@/lib/mcp/tools/journals';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null,
};
const ACC = '44444444-4444-4444-4444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listJournalEntriesPage).mockResolvedValue({ entries: [], nextCursor: 'c2' });
});

describe('list_journals', () => {
  it('is a free read tool on read:reports', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain('list_journals');
    expect(listJournalsTool.write).toBe(false);
    expect(listJournalsTool.scope).toBe('read:reports');
  });

  it('maps every filter, clamps the limit and passes ctx.companyId', async () => {
    const res = await listJournalsTool.handler({
      from_date: '2026-08-01', to_date: '2026-08-31', status: 'reversed', source: 'bank',
      account_id: ACC, include_lines: true, limit: 500, cursor: 'c1',
    }, ctx);
    expect(res.isError).toBeFalsy();
    expect(listJournalEntriesPage).toHaveBeenCalledWith(ctx.companyId, {
      fromDate: '2026-08-01', toDate: '2026-08-31', status: 'reversed', source: 'bank',
      accountId: ACC, includeLines: true, limit: 100, cursor: 'c1',
    });
    expect(JSON.parse(res.content[0]!.text)).toEqual({ journals: [], next_cursor: 'c2' });
  });

  it('treats include_lines as strict boolean true only', async () => {
    await listJournalsTool.handler({ include_lines: 'yes' }, ctx);
    expect(vi.mocked(listJournalEntriesPage).mock.calls[0]![1]!.includeLines).toBe(false);
  });

  it('refuses an unknown status before the service runs', async () => {
    const res = await listJournalsTool.handler({ status: 'void' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('invalid status');
    expect(listJournalEntriesPage).not.toHaveBeenCalled();
  });

  it('refuses uncastable dates and ids before the service runs', async () => {
    for (const args of [{ from_date: '2026-02-31' }, { to_date: 'junk' }, { account_id: 'abc' }]) {
      const res = await listJournalsTool.handler(args, ctx);
      expect(res.isError).toBe(true);
    }
    expect(listJournalEntriesPage).not.toHaveBeenCalled();
  });

  it('maps a bad cursor to a plain tool error and rethrows anything else', async () => {
    vi.mocked(listJournalEntriesPage).mockRejectedValueOnce(new InvalidCursorError());
    const res = await listJournalsTool.handler({ cursor: '!!' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('invalid cursor');

    vi.mocked(listJournalEntriesPage).mockRejectedValueOnce(new Error('boom'));
    await expect(listJournalsTool.handler({}, ctx)).rejects.toThrow('boom');
  });
});
