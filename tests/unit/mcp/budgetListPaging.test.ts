/**
 * The listed-cells page of the budget writes (review round 2, M-1): `list_limit` keeps PR 1's rule exactly. The MCP
 * layer does not enforce the JSON schema, so a limit that is not an integer (0.5, 2.5, "10") is the tool's default,
 * and an integer below 1 (0, -3) is 1: never 0, which would list no cell with the same next_offset (a loop for an
 * agent following it). Against set_budget_amounts (PR 1) and set_budget_drivers (PR 3), each listing 12 cells.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn(), loadGridCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridSave', async (orig) => ({ ...(await orig<object>()), saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/holderScope', async (orig) => ({ ...(await orig<object>()), loadHolderScope: vi.fn(async () => ({ reviews: [] })) }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverWriteService', () => ({ saveDriver: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverRepository', () => ({ listDriverLines: vi.fn(async () => []), listPlannedHires: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { saveDriver } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { setBudgetAmountsTool } from '@/lib/mcp/tools/budgetAmountTools';
import { setBudgetDriversTool } from '@/lib/mcp/tools/budgetDriverWrite';
import { listPage } from '@/lib/mcp/tools/budgetPaging';
import { MONTHS, RENT, TOKEN, VERSION, ctx, json, model, version } from './budgetToolsFixture';

const twelve = MONTHS.map((month) => ({ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month, amount: 5, source: 'driver' }));
let after: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  after = [];
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model({ cells: [] }));
  vi.mocked(loadGridCells).mockImplementation(async () => ({ versionId: VERSION, updatedAt: TOKEN, cells: after }) as never);
  vi.mocked(saveCells).mockImplementation(async () => { after = twelve; return { updatedAt: TOKEN, saved: 12, deleted: 0 }; });
  vi.mocked(saveDriver).mockImplementation(async () => { after = twelve; return { updatedAt: TOKEN, recomputed: 12, warnings: [], headcountAsOf: null } as never; });
});

const amounts = (list_limit: unknown) => setBudgetAmountsTool.handler({
  version_id: VERSION, idempotency_key: 'k', dry_run: true, list_limit, cells: MONTHS.map((month) => ({ account: '6000', month, amount: '5.00' })),
}, ctx());
const drivers = (list_limit: unknown) => setBudgetDriversTool.handler({
  version_id: VERSION, idempotency_key: 'k', dry_run: true, list_limit,
  changes: [{ op: 'set_driver', account: '6000', kind: 'fixed', amount: '5.00', from_month: MONTHS[0], to_month: MONTHS[11] }],
}, ctx());

describe.each([['set_budget_amounts', amounts], ['set_budget_drivers', drivers]])('%s list_limit', (_n, call) => {
  it.each([
    ['0.5 (not an integer: the default)', 0.5, 12, null],
    ['2.5 (not an integer: the default)', 2.5, 12, null],
    ['"10" (a string: the default)', '10', 12, null],
    ['0 (below 1: 1)', 0, 1, 1],
    ['-3 (below 1: 1)', -3, 1, 1],
    ['5', 5, 5, 5],
  ])('%s', async (_label, limit, listed, next) => {
    const out = json(await call(limit));
    expect([(out.cells as unknown[]).length, out.next_offset, out.listed_total]).toEqual([listed, next, 12]);
  });
});

describe('listPage never answers a limit below 1', () => {
  it.each([0.5, 0, -3, Number.NaN, '1', null, undefined, 1e9])('%s', (v) => {
    const { limit, offset } = listPage({ list_limit: v, list_offset: -2 }, 100, 400);
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(limit).toBeLessThanOrEqual(400);
    expect(offset).toBe(0);
  });
});
