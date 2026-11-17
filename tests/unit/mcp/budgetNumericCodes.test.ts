/**
 * An account or member code sent as a JSON number (review round 3): every budget tool that takes a code reads it the
 * same way, through one helper (`refText`): a finite integer is its digits, any other number is refused as "not an
 * account code" (or member / cost centre code), never truncated or ignored. Per tool: set_budget_amounts,
 * set_budget_annual, seed_budget (account_uplifts), get_budget (accounts, member), budget_remaining, set_budget_drivers
 * (account, cost_centre), add_budget_note.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn(), loadGridCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridSave', async (orig) => ({ ...(await orig<object>()), saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/seedVersion', () => ({ seedVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetNotes', async (orig) => ({ ...(await orig<object>()), setGridNote: vi.fn(async () => ({ note: 'n' })) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionActivity', () => ({ lastEditsOf: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({
  ...(await orig<object>()), loadChartRefs: vi.fn(),
  explainMissingAccounts: vi.fn(async (_c: string, refs: string[]) => new Map(refs.map((r) => [r, `${r} is not an account of this company`]))),
}));
vi.mock('@/modules/accounting/services/budgets/remainingBudget', async (orig) => ({ ...(await orig<object>()), remainingFor: vi.fn(async (_c: string, keys: unknown[]) => keys.map((key) => ({ key, versionId: null, grain: null, slice: { cc1Id: null, cc2Id: null, buId: null }, unassigned: false, offSlice: false, budget: null, actual: 0, committed: 0, remaining: null }))) }));
vi.mock('@/modules/accounting/services/budgets/holderScope', async (orig) => ({ ...(await orig<object>()), loadHolderScope: vi.fn(async () => ({ reviews: [] })) }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverWriteService', () => ({ saveDriver: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/plannedHireService', () => ({ createHire: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/drivers/driverRepository', () => ({ listDriverLines: vi.fn(async () => []), listPlannedHires: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { seedVersion } from '@/modules/accounting/services/budgets/seedVersion';
import { setGridNote } from '@/modules/accounting/services/budgets/budgetNotes';
import { loadChartRefs } from '@/modules/accounting/services/budgets/budgetRefResolve';
import { remainingFor } from '@/modules/accounting/services/budgets/remainingBudget';
import { saveDriver } from '@/modules/accounting/services/budgets/drivers/driverWriteService';
import { createHire } from '@/modules/accounting/services/budgets/drivers/plannedHireService';
import { setBudgetAmountsTool, setBudgetAnnualTool } from '@/lib/mcp/tools/budgetAmountTools';
import { seedBudgetTool } from '@/lib/mcp/tools/budgetSeedTool';
import { getBudgetTool } from '@/lib/mcp/tools/budgetReadTools';
import { addBudgetNoteTool } from '@/lib/mcp/tools/budgetVersionTools';
import { budgetRemainingTool } from '@/lib/mcp/tools/budgetControlTools';
import { setBudgetDriversTool } from '@/lib/mcp/tools/budgetDriverWrite';
import { refText } from '@/lib/mcp/tools/budgetToolArgs';
import { CC1, MONTHS, RENT, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';

/** The fixture's grid with a numerically coded CC1 member (101). */
const grid = () => model({ dimensions: { cc1: [{ id: CC1, code: '101', name: 'Centre', isActive: true }], cc2: [], bu: [] } as never });
const base = { version_id: VERSION, idempotency_key: 'k' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(grid());
  vi.mocked(loadGridCells).mockResolvedValue({ versionId: VERSION, updatedAt: TOKEN, cells: [] } as never);
  vi.mocked(saveCells).mockResolvedValue({ updatedAt: TOKEN, saved: 1, deleted: 0 } as never);
  vi.mocked(seedVersion).mockResolvedValue({ versionId: 'v-new', updatedAt: TOKEN, cells: 1, skippedAccounts: 0, roundingFlips: [] } as never);
  vi.mocked(saveDriver).mockResolvedValue({ updatedAt: TOKEN, recomputed: 0, warnings: [], headcountAsOf: null } as never);
  vi.mocked(createHire).mockResolvedValue({ updatedAt: TOKEN, recomputed: 0, warnings: [], headcountAsOf: null } as never);
  vi.mocked(loadChartRefs).mockResolvedValue({ accounts: [{ id: RENT, code: '6000' }], members: [{ id: CC1, code: '101', kind: 'cc1' }] });
});

describe('refText', () => {
  it.each([
    ['6000', { ref: '6000' }], [' 6000 ', { ref: '6000' }], [6000, { ref: '6000' }], [-12, { ref: '-12' }], [0, { ref: '0' }],
    [60.5, { error: '60.5 is not an account code' }], [Number.POSITIVE_INFINITY, { error: 'Infinity is not an account code' }], [Number.NaN, { error: 'NaN is not an account code' }],
    [undefined, { ref: '' }], [null, { ref: '' }], [true, { ref: '' }],
  ])('%s', (v, out) => expect(refText(v)).toEqual(out));

  it('names what the code is for', () => expect(refText(1.5, 'cc1')).toEqual({ error: '1.5 is not a cc1 code' }));
});

describe('each tool reads a whole number as its code and refuses a fraction', () => {
  it('set_budget_amounts (account and member)', async () => {
    await setBudgetAmountsTool.handler({ ...base, cells: [{ account: 6000, cc1: 101, month: MONTHS[1], amount: '5.00' }] }, ctx());
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([expect.objectContaining({ glAccountId: RENT, cc1Id: CC1 })]);
    const dry = json(await setBudgetAmountsTool.handler({ ...base, dry_run: true, cells: [{ account: 6000.5, month: MONTHS[1], amount: '5.00' }] }, ctx()));
    expect(JSON.stringify(dry.cells)).toMatch(/6000\.5 is not an account code/);
  });

  it('set_budget_annual', async () => {
    const dry = json(await setBudgetAnnualTool.handler({ ...base, dry_run: true, rows: [{ account: 6000, amount: '1200.00', spread: 'flat' }, { account: 1.5, amount: '1.00', spread: 'flat' }] }, ctx()));
    expect(dry.counts).toMatchObject({ refused: 1 });
    expect(JSON.stringify(dry.cells)).toMatch(/1\.5 is not an account code/);
    expect(vi.mocked(saveCells).mock.calls).toHaveLength(0);
  });

  it('seed_budget account_uplifts', async () => {
    const seed = { fiscal_year: 2027, name: 'S', kind: 'scenario', source: 'prior_year_actuals', idempotency_key: 'k', dry_run: true };
    await seedBudgetTool.handler({ ...seed, account_uplifts: [{ account: 6000, uplift_pct: 10 }] }, ctx());
    expect([...vi.mocked(seedVersion).mock.calls[0]![2].adjust!.accountUplift!]).toEqual([[RENT, 10]]);
    expect(text(await seedBudgetTool.handler({ ...seed, account_uplifts: [{ account: 6000.5, uplift_pct: 10 }] }, ctx()))).toMatch(/6000\.5 is not an account code/);
  });

  it('get_budget accounts and member', async () => {
    const out = json(await getBudgetTool.handler({ version_id: VERSION, accounts: [6000], level: 'cc1', member: 101 }, ctx()));
    expect(out.rows).toEqual([]);
    expect(text(await getBudgetTool.handler({ version_id: VERSION, accounts: [6000.5] }, ctx()))).toMatch(/6000\.5 is not an account code/);
    expect(text(await getBudgetTool.handler({ version_id: VERSION, level: 'cc1', member: 1.5 }, ctx()))).toMatch(/1\.5 is not a cc1 code/);
  });

  it('add_budget_note', async () => {
    await addBudgetNoteTool.handler({ ...base, account: 6000, note: 'n' }, ctx());
    expect(vi.mocked(setGridNote).mock.calls[0]![2]).toMatchObject({ glAccountId: RENT });
    expect(text(await addBudgetNoteTool.handler({ ...base, account: 6000.5, note: 'n' }, ctx()))).toMatch(/6000\.5 is not an account code/);
  });

  it('budget_remaining', async () => {
    const out = json(await budgetRemainingTool.handler({ lines: [{ account: 6000, cc1: 101, month: '2026-03' }, { account: 6000.5, month: '2026-03' }, { account: 6000, cc1: 1.5, month: '2026-03' }] }, ctx('manager', ['read:reports'])));
    expect(vi.mocked(remainingFor).mock.calls[0]![1]).toEqual([{ glAccountId: RENT, cc1Id: CC1, cc2Id: null, buId: null, month: '2026-03' }]);
    expect((out.lines as Array<{ refused?: string }>).map((l) => l.refused ?? null)).toEqual([null, '6000.5 is not an account code', '1.5 is not a cc1 code']);
  });

  it('set_budget_drivers (account, cost_centre)', async () => {
    await setBudgetDriversTool.handler({ ...base, dry_run: true, changes: [
      { op: 'set_driver', account: 6000, kind: 'fixed', amount: '5.00', from_month: MONTHS[0], to_month: MONTHS[1] },
      { op: 'add_hire', label: 'Rep', cost_centre: 101, start_month: MONTHS[0] },
    ] }, ctx());
    expect(vi.mocked(saveDriver).mock.calls[0]![3]).toMatchObject({ glAccountId: RENT });
    expect(vi.mocked(createHire).mock.calls[0]![3]).toMatchObject({ costCentreId: CC1 });
    const dry = json(await setBudgetDriversTool.handler({ ...base, dry_run: true, changes: [
      { op: 'set_driver', account: 6000.5, kind: 'fixed', amount: '5.00', from_month: MONTHS[0], to_month: MONTHS[1] },
      { op: 'add_hire', label: 'Rep', cost_centre: 1.5, start_month: MONTHS[0] },
    ] }, ctx()));
    expect(JSON.stringify(dry.refusals)).toMatch(/6000\.5 is not an account code.*1\.5 is not a cost centre code/);
  });
});
