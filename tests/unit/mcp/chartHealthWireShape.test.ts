/**
 * `chart_of_accounts_health` — the shape on the wire, not the shape in the service.
 *
 * The MCP connector is LIVE with pilots. `missingSystemAccounts` has always been
 * a list of role names, and a saved agent instruction or a human runbook that
 * reads it that way keeps working only if it stays that way. When the role
 * report grew a gap classification and a candidate list, the first version put
 * that detail INTO `missingSystemAccounts`, turning `string[]` into an array of
 * objects — a breaking wire change dressed as an improvement, invisible to any
 * agent holding a cached manifest, which gets objects where it expects strings
 * and has no way to know why its prompt stopped working.
 *
 * The detail belongs in a new field beside it. This test pins both halves: the
 * old field keeps its old shape, and the new one carries the detail.
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
  it('keeps missingSystemAccounts a list of plain role names', async () => {
    const r = await chartOfAccountsHealthTool.handler({}, ctx);
    const data = payload(r.content[0]!.text);

    expect(data.missingSystemAccounts).toEqual(['bank']);
    // Explicitly: every element is a string. An object here is the regression.
    for (const entry of data.missingSystemAccounts as unknown[]) {
      expect(typeof entry).toBe('string');
    }
  });

  it('carries the gap detail in systemRoleGaps, named so the remedy is obvious', async () => {
    const r = await chartOfAccountsHealthTool.handler({}, ctx);
    const data = payload(r.content[0]!.text);

    const gaps = data.systemRoleGaps as Array<Record<string, unknown>>;
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
