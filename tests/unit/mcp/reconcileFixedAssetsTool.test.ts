/**
 * `reconcile_fixed_assets` — the register against the ledger, decomposed.
 *
 * `asset_register` already reports the GAP. What nothing could do was say what
 * the gap is MADE OF. On Brightsphere the R7,500 the ledger calls accumulated
 * depreciation is a single manual journal (JE-2026-00318, "Sub-ledger recon
 * correction — clear double reversal imbalance (migration 479)") and not a
 * depreciation run at all; and every account subtyped fixed_assets that carries
 * a balance is a loan or investment account. A total hides both facts. Items
 * carrying account ids and journal ids do not.
 *
 * The assertions here are about the SHAPE of that decomposition, and each one
 * was written to go red against a specific way of getting it wrong:
 *  - items that do not sum to the difference (a decomposition that omits money)
 *  - a universeTotal synthesized from the numbers it is checked against
 *  - a credit-balance "fixed asset" account absorbed into a plausible total
 *  - a figure with no route to the documents underneath it
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/items/fixedAssetReconciliationService', () => ({
  reconcileFixedAssets: vi.fn(),
}));

import { reconcileFixedAssets } from '@/modules/accounting/services/items/fixedAssetReconciliationService';
import type { FixedAssetReconciliation } from '@/modules/accounting/services/items/fixedAssetReconciliationService';
import { reconcileFixedAssetsTool } from '@/lib/mcp/tools/reconcileFixedAssets';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
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

/**
 * Brightsphere, as production actually stands: one disposed asset on the
 * register and an asset section made of loan accounts.
 */
const REC: FixedAssetReconciliation = {
  asAt: '2026-08-31',
  registerCost: 0,
  registerAccumulatedDepreciation: 0,
  registerNetBookValue: 0,
  glCost: -5739802.67,
  glAccumulatedDepreciation: -7500,
  glNetBookValue: -5747302.67,
  difference: 5747302.67,
  itemsTotal: 5747302.67,
  unexplainedDifference: 0,
  items: [
    {
      side: 'ledger',
      type: 'ledger_account_balance',
      amount: -1135193.17,
      attribution: 'unlinked',
      attributedVia: null,
      assetId: null,
      assetNumber: null,
      accountId: 'g-loan',
      accountCode: '34024656',
      accountName: 'Loan Account - Hein Van Vuuren',
      accountSubtype: 'fixed_assets',
      normalBalanceViolated: false,
      postedLineCount: 1029,
      detail: 'GL balance 1135193.17 on an account subtyped fixed_assets.',
    },
    {
      side: 'ledger',
      type: 'ledger_account_balance',
      amount: 4847978.30,
      attribution: 'unlinked',
      attributedVia: null,
      assetId: null,
      assetNumber: null,
      accountId: 'g-h10',
      accountCode: '34550552',
      accountName: 'Loan Account - H10 Holdings (Pty) Ltd',
      accountSubtype: 'fixed_assets',
      normalBalanceViolated: true,
      postedLineCount: 172,
      detail: 'GL balance -4847978.30 on an account subtyped fixed_assets.',
    },
    {
      side: 'ledger',
      type: 'ledger_account_balance',
      amount: 7500,
      attribution: 'unlinked',
      attributedVia: null,
      assetId: null,
      assetNumber: null,
      accountId: 'g-1230',
      accountCode: '1230',
      accountName: 'Accumulated Depreciation',
      accountSubtype: 'accumulated_depreciation',
      normalBalanceViolated: false,
      postedLineCount: 1,
      detail: 'GL balance -7500.00 on an account subtyped accumulated_depreciation.',
    },
    {
      side: 'ledger',
      type: 'ledger_account_balance',
      amount: 2027017.54,
      attribution: 'unlinked',
      attributedVia: null,
      assetId: null,
      assetNumber: null,
      accountId: 'g-rest',
      accountCode: '35410044',
      accountName: 'Loan Account - X Approach',
      accountSubtype: 'fixed_assets',
      normalBalanceViolated: false,
      postedLineCount: 809,
      detail: 'GL balance -2027017.54 on an account subtyped fixed_assets.',
    },
  ],
  documents: [
    {
      accountId: 'g-1230',
      accountCode: '1230',
      journalEntryId: 'je-318',
      entryNumber: 'JE-2026-00318',
      entryDate: '2026-04-29',
      source: 'manual',
      description: 'Sub-ledger recon correction — clear double reversal imbalance (migration 479)',
      amount: -7500,
    },
  ],
  documentsTotal: 1,
  linkedItemCount: 0,
  unlinkedItemCount: 4,
  contraNormalBalanceCount: 1,
  contraNormalBalanceTotal: -4847978.30,
  registerLinkageAvailable: false,
  excludedRows: [
    {
      id: 'a-comp1',
      reason: 'disposed_before_as_at',
      detail: 'Disposed on 2026-04-12 for 8000.00; not carrying amount at 2026-08-31.',
      amount: 15000,
      documentNumber: 'COMP-0001',
    },
  ],
  postedThrough: '2026-04-29T12:32:47.355Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reconcileFixedAssets).mockResolvedValue(REC);
});

describe('registration', () => {
  it('is registered, mirrored to the client manifest, metered and read-only', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toContain('reconcile_fixed_assets');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('reconcile_fixed_assets');
    // A missing flowMetering entry is `undefined`, and fails the build's drift
    // test. `null` is the deliberate "free" answer every read carries.
    expect(flowOperationFor('reconcile_fixed_assets', {})).toBeNull();
    expect(reconcileFixedAssetsTool.write).toBe(false);
    expect(reconcileFixedAssetsTool.scope).toBe('read:reports');
  });

  it('states in its own words what a zero difference does NOT prove', () => {
    const d = reconcileFixedAssetsTool.description;
    expect(d).toMatch(/inspect the items/i);
    // "the books tie" is the reading this caveat exists to prevent.
    expect(d).not.toMatch(/the books tie/i);
    expect(d).toMatch(/necessary and not sufficient/i);
  });
});

describe('the decomposition', () => {
  it('itemises the difference and the items sum to it', async () => {
    const out = json(await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));

    expect(out.difference).toBeCloseTo(5747302.67, 2);
    const summed = out.rows.reduce(
      (s: number, r: { amount: number }) => s + r.amount,
      0,
    );
    expect(summed).toBeCloseTo(out.difference, 2);
    expect(out.unexplainedDifference).toBe(0);
  });

  it('carries an account id on every ledger item, so a figure has a route to its accounts', async () => {
    const out = json(await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));
    for (const row of out.rows) {
      if (row.side === 'ledger') expect(row.account_id).toBeTruthy();
    }
  });

  it('flags a credit-balance fixed-asset account rather than absorbing it into a total', async () => {
    const out = json(await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));
    const h10 = out.rows.find((r: { account_code: string }) => r.account_code === '34550552');

    expect(h10.normal_balance_violated).toBe(true);
    expect(out.contra_normal_balance_count).toBe(1);
    expect(out.contra_normal_balance_total).toBeCloseTo(-4847978.30, 2);
  });

  it('reports that no asset is linked to a GL account, rather than implying one is', async () => {
    const out = json(await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));
    expect(out.register_linkage_available).toBe(false);
    expect(out.linked_item_count).toBe(0);
    expect(out.unlinked_item_count).toBe(4);
  });

  it('excludes a disposed asset with the book value it was carrying, not silently', async () => {
    const out = json(await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));
    const ex = out.excludedRows.find((e: { id: string }) => e.id === 'a-comp1');
    expect(ex.reason).toBe('disposed_before_as_at');
    expect(ex.amount).toBe(15000);
  });
});

describe('the envelope', () => {
  it('makes NO completeness claim, because the rows are produced and not selected', async () => {
    const out = json(await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));
    // A universeTotal here could only be synthesized from rowsTotal +
    // excludedRows, which is the identity buildEnvelope checks it against, so
    // it could never fail. Absent is the honest answer.
    expect(out.universeTotal).toBeUndefined();
    expect(out.completenessFault).toBeUndefined();
  });

  it('pins posted_through to the ledger rows consumed, never to now()', async () => {
    const out = json(await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31' }, ctx));
    expect(out.posted_through).toBe('2026-04-29T12:32:47.355Z');
  });

  it('serves no rows at detail summary but still reports the difference', async () => {
    const out = json(await reconcileFixedAssetsTool.handler(
      { as_at: '2026-08-31', detail: 'summary' }, ctx,
    ));
    expect(out.rows).toHaveLength(0);
    expect(out.rowsTotal).toBe(4);
    expect(out.difference).toBeCloseTo(5747302.67, 2);
    expect(out.completenessFault).toBeUndefined();
  });

  it('serves the journals behind the accounts at detail full', async () => {
    const out = json(await reconcileFixedAssetsTool.handler(
      { as_at: '2026-08-31', detail: 'full' }, ctx,
    ));
    const je = out.rows.find((r: { entry_number?: string }) => r.entry_number === 'JE-2026-00318');
    expect(je.source).toBe('manual');
    expect(je.account_code).toBe('1230');
    expect(je.amount).toBe(-7500);
  });
});

describe('tenant and argument fences', () => {
  it('takes the company from the context, never from args', async () => {
    await reconcileFixedAssetsTool.handler({ as_at: '2026-08-31', company_id: OTHER }, ctx);
    expect(vi.mocked(reconcileFixedAssets).mock.calls[0]![0]).toBe(COMPANY);
  });

  it('refuses a malformed as_at before it reaches a cast', async () => {
    const res = await reconcileFixedAssetsTool.handler({ as_at: '2026-02-31' }, ctx);
    expect(res.isError).toBe(true);
    expect(reconcileFixedAssets).not.toHaveBeenCalled();
  });
});
