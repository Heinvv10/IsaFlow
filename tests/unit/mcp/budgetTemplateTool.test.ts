/**
 * get_budget_template (MCP budget tools PR 2): the app's template for a version, as a paged JSON grid (the main
 * path: rows of account / dimension and one decimal-text amount per month, blank = null, FY total, PY actual, the
 * version's section totals) or as the SAME .xlsx the template route builds (base64, its file name and _meta
 * signature), refused with a way out when the file would not fit one reply. Reads as the token user (a holder's
 * slices), another company's version is the shared NOT_FOUND, and the xlsx build shares the template route's
 * rate bucket and CPU slot.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/priorActuals', async (orig) => ({ ...(await orig<object>()), loadPriorActuals: vi.fn() }));

import { checkRateLimit } from '@/lib/rateLimit';
import { BUDGET_SPREADSHEET_SLOT, CpuSlotBusyError } from '@/lib/withCpuSlot';
import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { loadPriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { parseMeta, readBudgetWorkbook } from '@/modules/accounting/services/budgets/budgetImportParse';
import { getBudgetTemplateTool as tool, TEMPLATE_LIMIT_DEFAULT, XLSX_MAX_BASE64 } from '@/lib/mcp/tools/budgetTemplateTool';
import { NOT_FOUND } from '@/lib/mcp/tools/toolHelpers';
import { CC1, MONTHS, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';

vi.stubEnv('JWT_SECRET', 'k'.repeat(40)); // the template signature's key (any value)

const prior = (cells: Array<{ glAccountId: string; dimensionId: string | null; month: string; amount: number }> = []) =>
  ({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: MONTHS, cells }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model());
  vi.mocked(loadPriorActuals).mockResolvedValue(prior([{ glAccountId: RENT, dimensionId: null, month: '2026-04', amount: 90.5 }]));
});

type Row = { account: string; account_id: string; section: string; months: Record<string, string | null>; fy_total: string; py_actual: string | null; dimension?: string };

describe('get_budget_template, format json (the default)', () => {
  it('the template\'s rows: every budgetable account, every month (null = not budgeted), FY total, PY actual, as the token user', async () => {
    const out = json(await tool.handler({ version_id: VERSION }, ctx('viewer', ['read:reports'])));
    expect(loadGridReadModel).toHaveBeenCalledWith(expect.any(String), { versionId: VERSION }, 'totals', 'u-1');
    expect(out).toMatchObject({ format: 'json', version_token: TOKEN, grain: 'company', months: MONTHS, rows_total: 3, next_offset: null });
    const rows = out.rows as Row[];
    // Revenue first (band order), the header without its own amounts left out (its sub-account is the row).
    expect(rows.map((r) => r.account)).toEqual(['4000', '6000', '7100']);
    const rent = rows.find((r) => r.account === '6000')!;
    expect(rent).toMatchObject({ account_id: RENT, section: 'operating_expense', fy_total: '100.00', py_actual: '90.50' });
    expect(rent.months).toEqual(Object.fromEntries(MONTHS.map((m) => [m, m === '2026-03' ? '100.00' : null])));
    expect(rows.find((r) => r.account === '4000')).toMatchObject({ account_id: SALES, fy_total: '0.00', py_actual: null });
    expect((out.totals as Record<string, { year: string }>).operatingExpenses.year).toBe('100.00');
  });

  it('pages: limit / offset, rows_total over the whole template, next_offset', async () => {
    const first = json(await tool.handler({ version_id: VERSION, limit: 2 }, ctx()));
    expect([(first.rows as Row[]).length, first.rows_total, first.next_offset]).toEqual([2, 3, 2]);
    const second = json(await tool.handler({ version_id: VERSION, limit: 2, offset: 2 }, ctx()));
    expect([(second.rows as Row[]).map((r) => r.account), second.next_offset]).toEqual([['7100'], null]);
    expect(TEMPLATE_LIMIT_DEFAULT).toBeGreaterThanOrEqual(2);
  });

  it('a dimension grain: one row per account x named member, with the member\'s code and id', async () => {
    const out = json(await tool.handler({ version_id: VERSION, grain: 'cc1', members: [CC1] }, ctx()));
    expect((out.rows as Row[]).map((r) => `${r.account}/${r.dimension}`)).toEqual(['4000/C1', '7100/C1']); // 6000 is budgeted at company level (decision 4)
    expect((out.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ dimension_id: CC1, dimension_name: 'Centre' });
  });

  it.each([
    ['members at company grain', { grain: 'company', members: [CC1] }, /members picks the rows of a CC1, CC2 or BU template/],
    ['an unknown member', { grain: 'cc1', members: ['30000000-0000-4000-8000-00000000ffff'] }, /is not one of this company's CC1 members/],
    ['a bad grain', { grain: 'region' }, /grain must be one of/],
    ['a bad format', { format: 'csv' }, /format must be json or xlsx/],
    ['a member that is not an id', { grain: 'cc1', members: ['C1'] }, /members must be member ids/],
  ])('refused: %s', async (_n, args, why) => {
    const r = await tool.handler({ version_id: VERSION, ...args }, ctx());
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(why)]);
  });

  it('another company\'s version (or none) is the shared NOT_FOUND, before any grid is read', async () => {
    vi.mocked(getVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    expect(text(await tool.handler({ version_id: VERSION }, ctx()))).toBe(NOT_FOUND);
    expect(loadGridReadModel).not.toHaveBeenCalled();
  });
});

describe('get_budget_template, format xlsx', () => {
  it('the template route\'s workbook as base64, its file name and the _meta signature the import checks', async () => {
    const out = json(await tool.handler({ version_id: VERSION, format: 'xlsx' }, ctx()));
    expect(out).toMatchObject({ format: 'xlsx', file_name: 'budget-FY2027-Budget-company.xlsx', version_token: TOKEN, rows: 3 });
    const file = Buffer.from(String(out.file_base64), 'base64');
    expect(out.bytes).toBe(file.length);
    const wb = await readBudgetWorkbook(file);
    const meta = parseMeta(wb.meta);
    expect(meta).toMatchObject({ versionId: VERSION, fiscalYear: 2027, grain: 'company', updatedAt: TOKEN });
    expect(out.signature).toBe(meta.signature);
    const excel = new ExcelJS.Workbook();
    await excel.xlsx.load(file as unknown as ArrayBuffer);
    expect(excel.worksheets.map((s) => s.name)).toEqual(['Budget', 'Instructions', '_base', '_meta']);
    expect(checkRateLimit).toHaveBeenCalledWith('budget-template:u-1', { max: 60, windowSecs: 900 });
  });

  it('a workbook whose base64 would not fit one reply is refused, pointing at format json and fewer members', async () => {
    const many = Array.from({ length: 900 }, (_, i) => ({
      ...model().accounts[0]!, id: `a${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`, code: `X${i}`, name: `Account ${i} ${'n'.repeat(40)}`,
    }));
    const cells = many.flatMap((a, i) => MONTHS.map((month, m) => ({ glAccountId: a.id, cc1Id: null, cc2Id: null, buId: null, month, amount: 1000 + i * 13.37 + m, source: 'manual' })));
    vi.mocked(loadGridReadModel).mockResolvedValue(model({ accounts: many, cells }));
    const r = await tool.handler({ version_id: VERSION, format: 'xlsx' }, ctx());
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(new RegExp(`over the ${Math.round(XLSX_MAX_BASE64 / 1000)} KB one reply can carry.*format json`))]);
  });

  it('shares the template route\'s rate bucket and CPU slot', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);
    expect(text(await tool.handler({ version_id: VERSION, format: 'xlsx' }, ctx()))).toMatch(/Too many template downloads/);
    const run = vi.spyOn(BUDGET_SPREADSHEET_SLOT, 'run').mockRejectedValueOnce(new CpuSlotBusyError('budget spreadsheet', 'queue-full'));
    expect(text(await tool.handler({ version_id: VERSION, format: 'xlsx' }, ctx()))).toMatch(/busy building other spreadsheets/);
    expect(run).toHaveBeenCalledWith(expect.any(Function), 'u-1');
    run.mockRestore();
  });
});
