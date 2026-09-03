/**
 * MCP asset tools: list_fixed_assets and asset_register.
 *
 * `asset_register` is the one that has to prove something. A register on its
 * own repeats whatever the `assets` table says; the reconciliation to the GL is
 * what shows that on these books the two disagree in both directions — a
 * register carrying R15,000 of a computer that was sold in April, against a
 * ledger carrying R7,500 of accumulated depreciation and no asset cost at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/items/assetRegisterService', () => ({
  getAssetRegister: vi.fn(),
  getAssetGlReconciliation: vi.fn(),
}));

import {
  getAssetRegister,
  getAssetGlReconciliation,
} from '@/modules/accounting/services/items/assetRegisterService';
import { listFixedAssetsTool, assetRegisterTool } from '@/lib/mcp/tools/assets';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';

const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333',
  companyId: COMPANY,
  scopes: ['read:reports'],
  tokenJti: 'j',
  oauthAppId: null,
};

const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

const HELD = {
  id: 'a1', assetNumber: 'COMP-0002', name: 'Laptop', category: 'computers',
  status: 'assigned', purchaseDate: '2025-06-01', purchasePrice: 20000,
  accumulatedDepreciation: 5000, netBookValue: 15000,
  disposalDate: null, disposalAmount: null,
};
const DISPOSED = {
  ...HELD, id: 'a2', assetNumber: 'COMP-0001', name: 'QA Test Computer',
  status: 'disposed', purchasePrice: 15000, accumulatedDepreciation: 0,
  netBookValue: 15000, disposalDate: '2026-04-12', disposalAmount: 8000,
};

const PAGE = {
  rows: [HELD], rowsTotal: 1, universeTotal: 2, disposed: [DISPOSED],
  totals: { cost: 20000, accumulatedDepreciation: 5000, netBookValue: 15000 },
  hasMore: false,
};

const RECONCILIATION = {
  costAccounts: [{
    accountId: 'g2', accountCode: '34550552',
    accountName: 'Loan Account - H10 Holdings (Pty) Ltd',
    subtype: 'fixed_assets', balance: -4847978.30, isActive: true,
  }],
  glCost: -4847978.30,
  accumulatedDepreciationAccounts: [{
    accountId: 'g1', accountCode: '1230', accountName: 'Accumulated Depreciation',
    subtype: 'accumulated_depreciation', balance: -7500, isActive: true,
  }],
  glAccumulatedDepreciation: -7500,
  glNetBookValue: -4855478.30,
  registerCost: 20000,
  registerAccumulatedDepreciation: 5000,
  registerNetBookValue: 15000,
  difference: 4870478.30,
  postedThrough: '2026-04-12T08:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAssetRegister).mockResolvedValue(PAGE);
  vi.mocked(getAssetGlReconciliation).mockResolvedValue(RECONCILIATION);
});

describe('registration', () => {
  it('both tools are registered, mirrored, and read-only', () => {
    for (const n of ['list_fixed_assets', 'asset_register']) {
      expect(MCP_TOOLS.map((t) => t.name)).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES).toContain(n);
    }
    for (const t of [listFixedAssetsTool, assetRegisterTool]) expect(t.write).toBe(false);
  });
});

describe('list_fixed_assets', () => {
  it('reports a disposed asset as excluded, with the book value it was carrying', async () => {
    const env = json(await listFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));
    const excluded = env.excludedRows.find((e: { id: string }) => e.id === 'a2');

    expect(excluded.reason).toBe('disposed_before_as_at');
    expect(excluded.amount).toBe(15000);
    // 1 held + 1 disposed = the universe of 2.
    expect(env.rowsTotal + env.excludedRows.length).toBe(env.rowsReturned + 1);
    expect(env.completenessFault).toBeUndefined();
  });

  it('takes the company from the context, never from args', async () => {
    await listFixedAssetsTool.handler({ as_at: '2026-08-31', company_id: OTHER }, ctx);
    expect(vi.mocked(getAssetRegister).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses a malformed as_at before it reaches a cast', async () => {
    const res = await listFixedAssetsTool.handler({ as_at: '2026-02-31' }, ctx);
    expect(res.isError).toBe(true);
    expect(getAssetRegister).not.toHaveBeenCalled();
  });
});

describe('asset_register — register against ledger', () => {
  it('returns both carrying amounts and the gap between them', async () => {
    const out = json(await assetRegisterTool.handler({ as_at: '2026-08-31' }, ctx));
    expect(out.reconciliation.register_net_book_value).toBe(15000);
    expect(out.reconciliation.gl_net_book_value).toBeCloseTo(-4855478.30, 2);
    expect(out.reconciliation.difference).toBeCloseTo(4870478.30, 2);
    expect(out.reconciliation.reconciled).toBe(false);
  });

  it('names the GL accounts behind each side, so a misclassification is visible', async () => {
    const out = json(await assetRegisterTool.handler({ as_at: '2026-08-31' }, ctx));
    // Every aggregate must offer a route to what is behind it. Here that route
    // is the whole point: the entire fixed_assets subtype is loan accounts.
    expect(out.reconciliation.cost_accounts[0].account_name)
      .toBe('Loan Account - H10 Holdings (Pty) Ltd');
    expect(out.reconciliation.accumulated_depreciation_accounts[0].account_code).toBe('1230');
  });

  it('says reconciled only when the gap is actually zero', async () => {
    vi.mocked(getAssetGlReconciliation).mockResolvedValue({
      ...RECONCILIATION, glCost: 20000, glAccumulatedDepreciation: -5000,
      glNetBookValue: 15000, difference: 0,
    });
    const out = json(await assetRegisterTool.handler({ as_at: '2026-08-31' }, ctx));
    expect(out.reconciliation.reconciled).toBe(true);
  });

  it('pins posted_through to the ledger, not to now()', async () => {
    const out = json(await assetRegisterTool.handler({ as_at: '2026-08-31' }, ctx));
    expect(out.posted_through).toBe('2026-04-12T08:00:00.000Z');
  });

  it('takes the company from the context, never from args', async () => {
    await assetRegisterTool.handler({ as_at: '2026-08-31', company_id: OTHER }, ctx);
    expect(vi.mocked(getAssetGlReconciliation).mock.calls[0]![0]).toBe(COMPANY);
  });
});
