// RED phase — written before implementation.
/**
 * MCP read tool `list_gl_accounts`.
 *
 * Pilot feedback: agents resolved account codes to UUIDs one at a time through
 * `search_gl`'s `meta.accountId`, which needs a date range and returns ledger
 * lines nobody wanted. This tool hands back the chart of accounts in one call.
 *
 * The load-bearing assertions here are (a) the service is called with
 * `ctx.companyId` and NOTHING from args — mutation-checked below — and (b) an
 * unknown `account_type` is refused before the service call rather than
 * silently returning an empty list, which would read to an agent as "this
 * company has no expense accounts".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    fmtDate: vi.fn(() => '2026-08-28'),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  getChartOfAccounts: vi.fn(),
}));

import { getChartOfAccounts } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { listGlAccountsTool, searchGlTool } from '@/lib/mcp/tools/reports';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import type { GLAccount } from '@/modules/accounting/types/gl.types';

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_COMPANY = '33333333-3333-3333-3333-333333333333';

const ctx = (): McpToolContext => ({
  userId: '11111111-1111-1111-1111-111111111111',
  companyId: COMPANY_ID,
  scopes: ['read:reports'],
  tokenJti: 'jti-1',
  oauthAppId: null,
});

function parseOk(result: McpToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function account(over: Partial<GLAccount> & { id: string }): GLAccount {
  return {
    accountCode: '1000',
    accountName: 'Bank',
    accountType: 'asset',
    isActive: true,
    isSystemAccount: false,
    normalBalance: 'debit',
    level: 1,
    displayOrder: 0,
    defaultVatCode: 'none',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  } as GLAccount;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getChartOfAccounts).mockResolvedValue([]);
});

describe('list_gl_accounts', () => {
  it('maps service rows down to the agent-facing shape', async () => {
    vi.mocked(getChartOfAccounts).mockResolvedValue([
      account({
        id: '44444444-4444-4444-4444-444444444444',
        accountCode: '1100',
        accountName: 'FNB Cheque',
        accountType: 'asset',
        accountSubtype: 'bank',
        parentAccountId: '55555555-5555-5555-5555-555555555555',
      }),
      account({
        id: '66666666-6666-6666-6666-666666666666',
        accountCode: '5000',
        accountName: 'Rent',
        accountType: 'expense',
      }),
    ]);

    const body = parseOk(await listGlAccountsTool.handler({}, ctx()));
    expect(body.total).toBe(2);
    expect(body.accounts).toEqual([
      {
        id: '44444444-4444-4444-4444-444444444444',
        account_code: '1100',
        account_name: 'FNB Cheque',
        account_type: 'asset',
        account_subtype: 'bank',
        is_active: true,
        parent_account_id: '55555555-5555-5555-5555-555555555555',
      },
      {
        id: '66666666-6666-6666-6666-666666666666',
        account_code: '5000',
        account_name: 'Rent',
        account_type: 'expense',
        account_subtype: null,
        is_active: true,
        parent_account_id: null,
      },
    ]);
    // No internals bleed through: normal_balance, level, is_system_account and
    // has_transactions are ours, not the agent's.
    const first = (body.accounts as Record<string, unknown>[])[0]!;
    expect(Object.keys(first).sort()).toEqual([
      'account_code', 'account_name', 'account_subtype', 'account_type',
      'id', 'is_active', 'parent_account_id',
    ]);
  });

  it('calls the chart-of-accounts service with ctx.companyId, never an args-supplied one', async () => {
    // Mutation check: an implementation reading company_id from args (or
    // hardcoding anything else) fails here. `company_id` is passed as a hostile
    // argument — additionalProperties:false rejects it at the transport, and the
    // handler must ignore it even when called directly.
    await listGlAccountsTool.handler({ company_id: OTHER_COMPANY }, ctx());
    expect(getChartOfAccounts).toHaveBeenCalledTimes(1);
    expect(getChartOfAccounts).toHaveBeenCalledWith(COMPANY_ID, false);
    expect(vi.mocked(getChartOfAccounts).mock.calls[0]![0]).not.toBe(OTHER_COMPANY);
  });

  it('active_only defaults to true and flips the service includeInactive flag', async () => {
    await listGlAccountsTool.handler({ active_only: false }, ctx());
    expect(getChartOfAccounts).toHaveBeenCalledWith(COMPANY_ID, true);
    vi.mocked(getChartOfAccounts).mockClear();
    await listGlAccountsTool.handler({ active_only: true }, ctx());
    expect(getChartOfAccounts).toHaveBeenCalledWith(COMPANY_ID, false);
  });

  it('rejects an account_type outside the real enum WITHOUT querying', async () => {
    const bad = await listGlAccountsTool.handler({ account_type: 'assets' }, ctx());
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('account_type');
    // An empty list would read as "no such accounts exist" — a wrong answer,
    // not an error. Nothing may be queried on a rejected type.
    expect(getChartOfAccounts).not.toHaveBeenCalled();
  });

  it('accepts every type the service enum actually defines', async () => {
    for (const t of ['asset', 'liability', 'equity', 'revenue', 'expense']) {
      const r = await listGlAccountsTool.handler({ account_type: t }, ctx());
      expect(r.isError, `${t} must be accepted`).toBeFalsy();
    }
  });

  it('filters by account_type and by a case-insensitive code/name substring', async () => {
    vi.mocked(getChartOfAccounts).mockResolvedValue([
      account({ id: 'a1', accountCode: '1100', accountName: 'FNB Cheque', accountType: 'asset' }),
      account({ id: 'a2', accountCode: '5200', accountName: 'Bank Charges', accountType: 'expense' }),
      account({ id: 'a3', accountCode: '5300', accountName: 'Rent', accountType: 'expense' }),
    ]);

    const byType = parseOk(await listGlAccountsTool.handler({ account_type: 'expense' }, ctx()));
    expect((byType.accounts as { id: string }[]).map((a) => a.id)).toEqual(['a2', 'a3']);

    const byName = parseOk(await listGlAccountsTool.handler({ search: 'bank' }, ctx()));
    expect((byName.accounts as { id: string }[]).map((a) => a.id)).toEqual(['a2']);

    const byCode = parseOk(await listGlAccountsTool.handler({ search: '11' }, ctx()));
    expect((byCode.accounts as { id: string }[]).map((a) => a.id)).toEqual(['a1']);

    const both = parseOk(
      await listGlAccountsTool.handler({ account_type: 'expense', search: '53' }, ctx()),
    );
    expect((both.accounts as { id: string }[]).map((a) => a.id)).toEqual(['a3']);
  });

  it('defaults to 200 rows and clamps limit at 500, reporting the unclamped total', async () => {
    vi.mocked(getChartOfAccounts).mockResolvedValue(
      Array.from({ length: 600 }, (_, i) => account({ id: `id-${i}`, accountCode: String(i) })),
    );

    const dflt = parseOk(await listGlAccountsTool.handler({}, ctx()));
    expect((dflt.accounts as unknown[]).length).toBe(200);
    expect(dflt.total).toBe(600);

    const clamped = parseOk(await listGlAccountsTool.handler({ limit: 9999 }, ctx()));
    expect((clamped.accounts as unknown[]).length).toBe(500);

    const asked = parseOk(await listGlAccountsTool.handler({ limit: 5 }, ctx()));
    expect((asked.accounts as unknown[]).length).toBe(5);
  });

  it('is a free read on the same scope as search_gl, and is registered everywhere', () => {
    expect(listGlAccountsTool.write).toBe(false);
    expect(listGlAccountsTool.scope).toBe(searchGlTool.scope);
    expect(listGlAccountsTool.requiresPost).toBeFalsy();
    expect(listGlAccountsTool.inputSchema.additionalProperties).toBe(false);
    // The description is the only thing an agent reads before choosing a tool.
    expect(listGlAccountsTool.description).toContain('resolve account codes to UUIDs');

    expect(MCP_TOOLS.map((t) => t.name)).toContain('list_gl_accounts');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('list_gl_accounts');
    expect(MCP_TOOLS.filter((t) => !t.write)).toHaveLength(27);
    expect(MCP_TOOLS).toHaveLength(53);
  });
});
