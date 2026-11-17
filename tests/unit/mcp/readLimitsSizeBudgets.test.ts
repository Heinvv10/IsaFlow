/**
 * readLimitsSize.test.ts's rule for the budget reads (kept in its own file: that one is near the 300-line cap):
 * at their DEFAULT and MAXIMUM page, with worst-case rows (a 14-month year, every month filled with the widest
 * amount, long names and codes, mixed sources, 50 driver lines, 2 000-character notes with include_notes, a
 * 500-character unlock reason), the serialised reply stays under MAX_READ_RESULT_BYTES; a limit past the
 * maximum is clamped; a partial page says so (next_offset). get_budget_template (PR 2): its JSON page at the
 * default and maximum with the widest rows (14 months, widest amounts and PY actuals, long codes and names, a
 * dimension), and its xlsx reply with a workbook exactly at XLSX_MAX_BASE64.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn(), listVersions: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionActivity', () => ({ lastEditsOf: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/priorActuals', async (orig) => ({ ...(await orig<object>()), loadPriorActuals: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetTemplateXlsx', async (orig) => ({ ...(await orig<object>()), loadBudgetTemplate: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));

import { getVersion, listVersions } from '@/modules/accounting/services/budgets/budgetVersions';
import { lastEditsOf } from '@/modules/accounting/services/budgets/budgetVersionActivity';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { bandTotals } from '@/modules/accounting/services/budgets/gridTotals';
import type { GridAccount, GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import {
  BUDGET_VERSIONS_LIMIT_DEFAULT, BUDGET_VERSIONS_LIMIT_MAX, GET_BUDGET_LIMIT_DEFAULT, GET_BUDGET_LIMIT_MAX, GET_BUDGET_MAX_DRIVERS,
  GET_BUDGET_NOTES_LIMIT_MAX, getBudgetTool, listBudgetVersionsTool,
} from '@/lib/mcp/tools/budgetReadTools';
import { MAX_READ_RESULT_BYTES } from '@/lib/mcp/resultSize';
import { loadPriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { loadBudgetTemplate } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { getBudgetTemplateTool, TEMPLATE_LIMIT_DEFAULT, TEMPLATE_LIMIT_MAX, XLSX_MAX_BASE64 } from '@/lib/mcp/tools/budgetTemplateTool';
import { VERSION, ctx, version } from './budgetToolsFixture';

const ROWS = 1000;
const MONTHS = Array.from({ length: 14 }, (_, i) => `20${26 + Math.floor((i + 2) / 12)}-${String(((i + 2) % 12) + 1).padStart(2, '0')}`);
const id = (i: number, tag: string) => `${tag}${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`;
const long = (n: number, tag: string) => `${tag} ${'N'.repeat(n - tag.length - 1)}`;
const WIDEST = -9999999999999.99;
const bytes = (r: { content: Array<{ text: string }> }) => Buffer.byteLength(r.content[0]!.text, 'utf8');
const LONG_VERSION = version({ name: long(120, 'Version'), unlockReason: long(500, 'Reason'), total: WIDEST });

function worstModel(): GridReadModel {
  const accounts = Array.from({ length: ROWS }, (_, i) => ({
    id: id(i, 'a'), code: long(20, `C${i}`), name: long(120, `Account ${i}`), type: 'expense', subtype: null, band: 'operating_expense', isActive: true,
    parentId: null, depth: 0, isHeader: false, childIds: [], ownAmounts: false, grain: 'cc1', rollup: null, note: long(2000, `Note ${i}`),
  })) as GridAccount[];
  const cc1 = Array.from({ length: ROWS }, (_, i) => ({ id: id(i, 'c'), code: long(20, `M${i}`), name: 'm', isActive: true }));
  const sources = ['manual', 'driver', 'override', 'actual'] as const;
  const cells: GridCell[] = accounts.flatMap((a, i) => MONTHS.map((month, m) => ({
    glAccountId: a.id, cc1Id: cc1[i]!.id, cc2Id: null, buId: null, month, amount: WIDEST, source: sources[m % 4]!,
  })));
  const drivers = Array.from({ length: 200 }, (_, i) => ({
    id: id(i, 'd'), updatedAt: '2026-11-16T10:00:00.000001Z', glAccountId: accounts[i]!.id, cc1Id: cc1[i]!.id, cc2Id: null, buId: null, kind: 'fixed' as const,
    fromMonth: MONTHS[0]!, toMonth: MONTHS[13]!, amount: WIDEST, pct: 999.9999, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: null, rounding: 1 as const,
  }));
  return {
    version: LONG_VERSION as never, updatedAt: '2026-11-16T10:00:00.000001Z',
    year: { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-04-30', kind: 'transition', monthKeys: MONTHS } as never,
    accounts, dimensions: { cc1, cc2: [], bu: [] }, cells, grains: {}, drivers,
    totals: bandTotals(accounts, new Map(accounts.map((a) => [a.id, Array(14).fill(-999999999999999)])), 14), holder: null,
  };
}

describe('get_budget page sizes', () => {
  vi.mocked(getVersion).mockResolvedValue(LONG_VERSION as never);
  it.each([
    ['default', {}, GET_BUDGET_LIMIT_DEFAULT],
    ['maximum', { limit: GET_BUDGET_LIMIT_MAX }, GET_BUDGET_LIMIT_MAX],
    ['past the maximum (clamped)', { limit: 10_000 }, GET_BUDGET_LIMIT_MAX],
    ['notes, at the notes maximum', { include_notes: true, limit: GET_BUDGET_LIMIT_MAX }, GET_BUDGET_NOTES_LIMIT_MAX],
  ])('%s: under MAX_READ_RESULT_BYTES with drivers', async (_n, extra, rows) => {
    vi.mocked(loadGridReadModel).mockResolvedValue(worstModel());
    const r = await getBudgetTool.handler({ version_id: VERSION, include_drivers: true, ...extra }, ctx());
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text) as { rows: unknown[]; next_offset: number | null; drivers: unknown[] };
    expect([out.rows.length, out.next_offset, out.drivers.length]).toEqual([rows, rows, GET_BUDGET_MAX_DRIVERS]);
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });
});

describe('list_budget_versions page sizes', () => {
  const many = Array.from({ length: 500 }, (_, i) => version({
    id: id(i, 'v'), name: long(120, `Version ${i}`), unlockReason: long(500, 'Reason'), total: WIDEST,
    basedOnVersionId: id(i, 'b'), approvedBy: id(i, 'u'), lockedBy: id(i, 'u'), unlockedBy: id(i, 'u'),
    approvedAt: '2026-11-16T10:00:00.000001Z', lockedAt: '2026-11-16T10:00:00.000001Z', unlockedAt: '2026-11-16T10:00:00.000001Z', createdBy: id(i, 'u'),
  }));
  it.each([['default', {}, BUDGET_VERSIONS_LIMIT_DEFAULT], ['maximum', { limit: BUDGET_VERSIONS_LIMIT_MAX }, BUDGET_VERSIONS_LIMIT_MAX], ['past the maximum', { limit: 9999 }, BUDGET_VERSIONS_LIMIT_MAX]])(
    '%s: under MAX_READ_RESULT_BYTES, total over the whole set, next_offset', async (_n, extra, rows) => {
      vi.mocked(listVersions).mockResolvedValue(many as never);
      vi.mocked(lastEditsOf).mockResolvedValue(new Map(many.map((v) => [v.id, { at: '2026-11-16T10:00:00Z', by: v.createdBy, action: 'update' }])));
      const r = await listBudgetVersionsTool.handler(extra, ctx());
      const out = JSON.parse(r.content[0]!.text) as { items: unknown[]; total: number; next_offset: number | null };
      expect([out.items.length, out.total, out.next_offset]).toEqual([rows, 500, rows]);
      expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
    });
});

describe('get_budget_template page sizes', () => {
  vi.stubEnv('JWT_SECRET', 'k'.repeat(40)); // the template signature's key (any value)
  /** 200 accounts never budgeted elsewhere, one long CC1 member: a 200-row CC1 template of the widest rows. */
  function templateModel(): GridReadModel {
    const m = worstModel();
    const accounts = m.accounts.slice(0, 200).map((a) => ({ ...a, grain: null }));
    const member = { id: id(0, 'c'), code: long(20, 'M0'), name: long(120, 'Member'), isActive: true };
    const cells = accounts.flatMap((a) => MONTHS.map((month) => ({ glAccountId: a.id, cc1Id: member.id, cc2Id: null, buId: null, month, amount: WIDEST, source: 'manual' as const })));
    return { ...m, accounts, dimensions: { cc1: [member], cc2: [], bu: [] }, cells, drivers: [] };
  }
  it.each([
    ['default', {}, TEMPLATE_LIMIT_DEFAULT],
    ['maximum', { limit: TEMPLATE_LIMIT_MAX }, TEMPLATE_LIMIT_MAX],
    ['past the maximum (clamped)', { limit: 10_000 }, TEMPLATE_LIMIT_MAX],
  ])('json, %s: under MAX_READ_RESULT_BYTES', async (_n, extra, rows) => {
    vi.mocked(getVersion).mockResolvedValue(LONG_VERSION as never);
    const model = templateModel();
    vi.mocked(loadGridReadModel).mockResolvedValue(model);
    vi.mocked(loadPriorActuals).mockResolvedValue({ fiscalYear: 2027, grain: 'cc1', months: MONTHS, priorMonths: MONTHS,
      cells: model.cells.map((c) => ({ glAccountId: c.glAccountId, dimensionId: c.cc1Id, month: c.month, amount: WIDEST })) } as never);
    const r = await getBudgetTemplateTool.handler({ version_id: VERSION, grain: 'cc1', members: [id(0, 'c')], ...extra }, ctx());
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text) as { rows: Array<{ months: Record<string, string> }>; next_offset: number | null };
    expect([out.rows.length, out.next_offset, Object.keys(out.rows[0]!.months).length]).toEqual([rows, rows, 14]);
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });

  it('xlsx: a workbook exactly at XLSX_MAX_BASE64 with a long file name still fits', async () => {
    vi.mocked(getVersion).mockResolvedValue(LONG_VERSION as never);
    vi.mocked(loadBudgetTemplate).mockResolvedValue({
      file: Buffer.alloc((XLSX_MAX_BASE64 / 4) * 3, 7), fileName: `budget-FY2027-${'N'.repeat(60)}-company.xlsx`,
      meta: { versionId: VERSION, fiscalYear: 2027, grain: 'company', updatedAt: '2026-11-16T10:00:00.000001Z', templateVersion: 1, signature: 'f'.repeat(64) }, rows: 8333,
    });
    const r = await getBudgetTemplateTool.handler({ version_id: VERSION, format: 'xlsx' }, ctx());
    expect((JSON.parse(r.content[0]!.text) as { file_base64: string }).file_base64).toHaveLength(XLSX_MAX_BASE64);
    expect(bytes(r)).toBeLessThan(MAX_READ_RESULT_BYTES);
  });
});
