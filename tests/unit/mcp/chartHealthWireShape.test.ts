/**
 * `chart_of_accounts_health` — the shape on the wire, not the shape in the service.
 *
 * `missingSystemAccounts` used to be `string[]` and now carries objects. On a
 * live connector that is an external contract change, and it was raised as one.
 * It was settled by MEASUREMENT rather than by argument: `mcp_tool_calls` in
 * production holds 6,615 calls across 4 companies and not one is
 * `chart_of_accounts_health` — the tool has never been invoked, so nothing
 * reads the field and there is nothing to break. A parallel `string[]` kept for
 * compatibility would have been two arrays of the same roles maintained for a
 * consumer that does not exist.
 *
 * The test stays, pinning the shape that was chosen. The next person to change
 * it should have to change a test and re-run that query, not discover a broken
 * pilot. If this tool ever acquires real callers, THAT is when the shape becomes
 * expensive to move.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const getChartOfAccountsHealth = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/gl/chartOfAccountsHealthService', () => ({
  getChartOfAccountsHealth,
}));

import { chartOfAccountsHealthTool } from '@/lib/mcp/tools/integrity';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';

const ctx: McpToolContext = {
  userId: 'user-1',
  companyId: COMPANY_ID,
  scopes: ['read:reports'],
  tokenJti: 'pat-1',
  oauthAppId: null,
};

/** Brightsphere's real shape: bank empty next to the account holding the history. */
const BANK_GAP = {
  key: 'bank',
  state: 'empty' as const,
  gap: 'unflagged_active_claimant' as const,
  claimants: [{
    id: 'x', accountCode: '1049686', accountName: 'Brighttech Absa',
    accountType: 'asset', accountSubtype: 'bank', createdAt: 0,
    isActive: true, isSystemAccount: false,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getChartOfAccountsHealth.mockResolvedValue({
    asAt: '2026-09-04',
    summary: { findingCounts: {} },
    rows: [],
    rowsTotal: 0,
    universeTotal: 40,
    missingSystemAccounts: [BANK_GAP],
    contestedSystemAccounts: [],
    systemRoles: [BANK_GAP],
    postedThrough: '2026-09-04T00:00:00.000Z',
  });
});

function payload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('chart_of_accounts_health wire shape', () => {
  it('reports every empty role', async () => {
    const r = await chartOfAccountsHealthTool.handler({}, ctx);
    const data = payload(r.content[0]!.text);

    const gaps = data.missingSystemAccounts as Array<Record<string, unknown>>;
    expect(gaps.map((g) => g.role)).toEqual(['bank']);
  });

  it('carries the gap shape and the candidates, so the remedy is unambiguous', async () => {
    const r = await chartOfAccountsHealthTool.handler({}, ctx);
    const data = payload(r.content[0]!.text);

    const gaps = data.missingSystemAccounts as Array<Record<string, unknown>>;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].role).toBe('bank');
    // Without the gap shape the reader cannot tell "create an account" from
    // "flag the one you already have", and Brightsphere had 8,342 bank
    // transactions on the account that only needed the flag.
    expect(gaps[0].gap).toBe('unflagged_active_claimant');
    const candidates = gaps[0].candidates as Array<Record<string, unknown>>;
    expect(candidates[0].accountCode).toBe('1049686');
    expect(candidates[0].isSystemAccount).toBe(false);
  });
});
