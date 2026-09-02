/**
 * Cursor paging on list_gl_accounts. The chart is filtered in memory; the
 * cursor names the last row served, so a concurrent insert cannot shift pages.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), fmtDate: vi.fn(() => '2026-09-02') }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ getChartOfAccounts: vi.fn() }));

import { getChartOfAccounts } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { listGlAccountsTool } from '@/lib/mcp/tools/reports';
import { decodeGlAccountCursor, encodeGlAccountCursor, startIndexAfter } from '@/lib/mcp/tools/glAccountCursor';
import type { McpToolContext } from '@/lib/mcp/types';
import type { GLAccount } from '@/modules/accounting/types/gl.types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null,
};
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
function acc(n: number, code: string): GLAccount {
  return { id: id(n), accountCode: code, accountName: `A${n}`, accountType: 'asset', isActive: true } as GLAccount;
}
type Body = { accounts: Array<{ id: string }>; total: number; next_cursor: string | null };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Body;

beforeEach(() => {
  vi.clearAllMocks();
  // Unsorted, with two rows sharing a code — the id tiebreak must keep them apart.
  vi.mocked(getChartOfAccounts).mockResolvedValue([acc(3, '2000'), acc(1, '1000'), acc(2, '1000'), acc(4, '3000'), acc(5, '4000')]);
});

describe('list_gl_accounts paging', () => {
  it('walks the whole chart in code order without repeating or dropping a row', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = parse(await listGlAccountsTool.handler({ limit: 2, cursor }, ctx));
      expect(body.total).toBe(5);
      seen.push(...body.accounts.map((a) => a.id));
      cursor = body.next_cursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  });

  it('reports next_cursor null when the page is exactly the remainder', async () => {
    const body = parse(await listGlAccountsTool.handler({ limit: 5 }, ctx));
    expect(body.accounts).toHaveLength(5);
    expect(body.next_cursor).toBeNull();
  });

  it('refuses a cursor it did not produce', async () => {
    const res = await listGlAccountsTool.handler({ cursor: 'nope' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('invalid cursor');
    const forged = Buffer.from(JSON.stringify({ code: '1', id: 'x' })).toString('base64url');
    expect(decodeGlAccountCursor(forged)).toBeNull();
  });

  it('startIndexAfter lands strictly after the cursor row', () => {
    const sorted = [acc(1, '1000'), acc(2, '1000'), acc(3, '2000')];
    const c = decodeGlAccountCursor(encodeGlAccountCursor(sorted[1]!))!;
    expect(startIndexAfter(sorted, c)).toBe(2);
    expect(startIndexAfter(sorted, { code: '0', id: id(9) })).toBe(0);
    expect(startIndexAfter(sorted, { code: '9', id: id(9) })).toBe(3);
  });
});
