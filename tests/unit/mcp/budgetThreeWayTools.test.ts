/**
 * get_three_way, set_three_way_assumptions and derive_three_way (MCP budget tools PR 3), services mocked:
 *  - the company's `budgets_three_way` flag gates all three before any service, as the app's routes;
 *  - money on the wire is decimal TEXT both ways (the services hold cents): a number in a money field is refused,
 *    day counts and shares stay numbers;
 *  - the assumptions save runs the app's saveAssumptions (its row token compare-and-set): dry run rolled back and
 *    key freed, stale / locked / invalid documents answered with the service's reason;
 *  - derive proposes and never saves, for budget writers only (the app's withWriteAccess).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: vi.fn(), deriveView: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/threeWay/assumptionsRepo', async (orig) => ({ ...(await orig<object>()), saveAssumptions: vi.fn(), readChain: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { deriveView, getThreeWay } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { readChain, saveAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsRepo';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import { AssumptionsStaleError } from '@/modules/accounting/services/budgets/threeWay/serviceErrors';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { deriveThreeWayTool, getThreeWayTool, setThreeWayAssumptionsTool } from '@/lib/mcp/tools/budgetThreeWayTools';
import { TOKEN, VERSION, ctx, json, text, version } from './budgetToolsFixture';

const doc = () => ({
  ...defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } }),
  capex: [{ id: 'cx1', month: '2026-06', amountExVat: 150000, vatClaimable: true, description: 'Laptop' }],
});
const wire = () => ({ ...doc(), capex: [{ id: 'cx1', month: '2026-06', amountExVat: '1500.00', vatClaimable: true, description: 'Laptop' }], minimumCash: { value: '0.00', source: 'derived', basis: 'default' } });
const head = { id: VERSION, name: 'Budget', kind: 'scenario', status: 'draft', fiscalYear: 2027, isPrimary: false, basedOnVersionId: null };
const base = { version_id: VERSION, idempotency_key: 'k' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasFeature).mockResolvedValue(true);
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(readChain).mockResolvedValue({ versions: new Map(), stored: null });
  vi.mocked(saveAssumptions).mockImplementation(async (_c, _u, input) => ({ doc: input.doc as never, updatedAt: TOKEN, updatedBy: 'u-1' }));
});

describe('the budgets_three_way flag gates every three-way tool before any service', () => {
  it.each([
    ['get_three_way', () => getThreeWayTool.handler({ version_id: VERSION }, ctx())],
    ['set_three_way_assumptions', () => setThreeWayAssumptionsTool.handler({ ...base, doc: wire(), assumptions_token: null }, ctx())],
    ['derive_three_way', () => deriveThreeWayTool.handler({ version_id: VERSION }, ctx())],
  ])('%s', async (_n, call) => {
    vi.mocked(hasFeature).mockResolvedValue(false);
    expect(text(await call())).toMatch(/balance sheet and cash budget is not enabled/);
    expect(getThreeWay).not.toHaveBeenCalled();
    expect(saveAssumptions).not.toHaveBeenCalled();
    expect(deriveView).not.toHaveBeenCalled();
  });
});

describe('get_three_way', () => {
  it('money as decimal text; day counts stay numbers; long lists capped with their totals', async () => {
    vi.mocked(getThreeWay).mockResolvedValue({
      version: head, months: ['2026-03'], lookback: [{ month: '2026-02', turnover: 100, costOfSales: 0, supplierPurchases: 0 }],
      opening: { asAt: '2026-02-28', provisional: false, buckets: { cash: 123456 }, balanceSheet: { totalAssets: 123456 }, totals: { assets: 1 }, equity: { posted: 0, derivedRetainedEarnings: -5 },
        unmapped: Array.from({ length: 150 }, (_, i) => ({ accountCode: `U${i}`, bucket: 'otherEquity', balance: 99 })) },
      pnl: [{ month: '2026-03', turnover: 250050, netProfit: -1 }], balanceSheet: [], cashFlow: { direct: [], indirect: [] },
      runway: { minimumCash: 0, firstBelowMinimum: null, minCash: 5, minCashMonth: '2026-03' },
      checks: { balanced: true, unbalancedMonths: [], openingCash: { bucket: 1, ledger: 1, difference: 0, accounts: [] } },
      warnings: [{ code: 'opening_excess_spread', series: 'receivables', days: 365, excess: 1001, months: 12 }],
      vatSettlements: [], taxEvents: [], assumptions: { resolved: doc(), chain: [VERSION], stored: null },
    } as never);
    const out = json(await getThreeWayTool.handler({ version_id: VERSION }, ctx('viewer', ['read:reports'])));
    expect(out.pnl).toEqual([{ month: '2026-03', turnover: '2500.50', netProfit: '-0.01' }]);
    expect((out.opening as { buckets: unknown }).buckets).toEqual({ cash: '1234.56' });
    expect(out.warnings).toEqual([{ code: 'opening_excess_spread', series: 'receivables', days: 365, excess: '10.01', months: 12 }]);
    expect(out.opening).toMatchObject({ unmapped_total: 150 });
    expect((out.opening as { unmapped: unknown[] }).unmapped).toHaveLength(50);
    expect((out.assumptions as { resolved: { capex: unknown[] } }).resolved.capex[0]).toMatchObject({ amountExVat: '1500.00' });
    expect(out.lookback).toBeUndefined();
  });

  it("another company's version is the shared Not found", async () => {
    vi.mocked(getVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    expect(text(await getThreeWayTool.handler({ version_id: VERSION }, ctx()))).toBe('Not found');
    expect(getThreeWay).not.toHaveBeenCalled();
  });
});

describe('set_three_way_assumptions', () => {
  it('a money field sent as a number is refused before the service (decimal strings only)', async () => {
    const bad = { ...wire(), capex: [{ ...wire().capex[0], amountExVat: 1500 }] };
    expect(text(await setThreeWayAssumptionsTool.handler({ ...base, doc: bad, assumptions_token: null }, ctx()))).toMatch(/capex\[0\]\.amountExVat.*decimal string/);
    expect(saveAssumptions).not.toHaveBeenCalled();
  });

  it('an invalid document is refused with each issue\'s path before the service', async () => {
    expect(text(await setThreeWayAssumptionsTool.handler({ ...base, doc: { ...wire(), colour: 'red' }, assumptions_token: null }, ctx()))).toMatch(/assumptions document is invalid/i);
    expect(saveAssumptions).not.toHaveBeenCalled();
  });

  it('assumptions_token is required (null when none is stored)', async () => {
    expect(text(await setThreeWayAssumptionsTool.handler({ ...base, doc: wire() }, ctx()))).toMatch(/assumptions_token is required/);
  });

  it('the dry run runs the app\'s save rolled back, lists the changed sections, frees the key', async () => {
    const r = await setThreeWayAssumptionsTool.handler({ ...base, doc: wire(), assumptions_token: null, dry_run: true }, ctx());
    expect(r.wroteNothing).toBe(true);
    expect(json(r)).toMatchObject({ dry_run: true, changed_sections: expect.arrayContaining(['capex', 'minimumCash']), previous: null });
    expect(vi.mocked(saveAssumptions).mock.calls[0]![2]).toEqual({ versionId: VERSION, doc: doc(), expectedUpdatedAt: null });
  });

  it('live: cents reach the service as the app sends them, the reply is decimal text with the previous document', async () => {
    vi.mocked(readChain).mockResolvedValue({ versions: new Map(), stored: { doc: { ...doc(), capex: [] }, updatedAt: '2026-11-16T09:00:00.000001Z', updatedBy: 'u-2' } });
    const out = json(await setThreeWayAssumptionsTool.handler({ ...base, doc: wire(), assumptions_token: '2026-11-16T09:00:00.000001Z' }, ctx()));
    expect(out).toMatchObject({ assumptions_token: TOKEN, changed_sections: ['capex'], previous: { capex: [] } });
    expect((out.assumptions as { capex: unknown[] }).capex[0]).toMatchObject({ amountExVat: '1500.00' });
    expect(vi.mocked(saveAssumptions).mock.calls[0]![2]).toMatchObject({ expectedUpdatedAt: '2026-11-16T09:00:00.000001Z' });
  });

  it.each([
    [new AssumptionsStaleError('2026-11-16T11:00:00.000001Z'), /changed since you opened them.*assumptions_token is now 2026-11-16T11:00:00.000001Z/],
    [new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked'), /This budget version is locked/],
  ])('the service refusal %s is answered (its savepoint rolled it back)', async (err, why) => {
    vi.mocked(saveAssumptions).mockRejectedValue(err);
    const r = await setThreeWayAssumptionsTool.handler({ ...base, doc: wire(), assumptions_token: null }, ctx());
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(why)]);
  });
});

describe('derive_three_way', () => {
  beforeEach(() => {
    vi.mocked(deriveView).mockResolvedValue({
      version: head, assumptions: doc(),
      evidence: { asAt: '2026-02-28', window: { first: '2025-03', last: '2026-02', months: 12, days: 365 }, trailing: { turnover: 1200000 }, aging: { receivables: 50, payables: 0 } },
    } as never);
  });

  it('a viewer is refused before the service (the app\'s derive is for budget writers)', async () => {
    expect(text(await deriveThreeWayTool.handler({ version_id: VERSION }, ctx('viewer', ['read:reports'])))).toMatch(/owners, admins and managers/);
    expect(deriveView).not.toHaveBeenCalled();
  });

  it('proposes assumptions with money as decimal text and saves nothing', async () => {
    const out = json(await deriveThreeWayTool.handler({ version_id: VERSION }, ctx('manager', ['read:reports'])));
    expect((out.assumptions as { capex: unknown[] }).capex[0]).toMatchObject({ amountExVat: '1500.00' });
    expect(out.evidence).toMatchObject({ window: { months: 12, days: 365 }, trailing: { turnover: '12000.00' }, aging: { receivables: '0.50' } });
    expect(saveAssumptions).not.toHaveBeenCalled();
  });
});
