/**
 * Builders for the management pack comparison tests (budgets P3 PR-D): an engine report, its bands
 * and lines, a pack config, and readers for the sections the generator writes. The generator itself
 * is imported here and resolved under the CALLING test file's vi.mock setup.
 */
import type { Mock } from 'vitest';
import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import type { ManagementPackConfig, NoteContent, NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';
import type { BudgetTrackingReport, TrackingBand, TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const figures = { projected: 0, fyBudget: null, projVariance: null, projFavourable: null, unallocatedBudget: 0 };
export const band = (key: TrackingBand['key'], label: string, actual: number, budget: number | null): TrackingBand => ({
  ...figures, key, label, kind: 'band', polarity: 'income', partialBudget: false, actual, budget,
  variance: budget === null ? null : actual - budget,
  variancePct: budget ? ((actual - budget) / budget) * 100 : null,
  favourable: budget === null ? null : actual >= budget,
});
export const line = (code: string, variance: number | null): TrackingLine => ({
  ...figures, accountId: code, accountCode: code, accountName: `Acc ${code}`, accountType: 'expense', band: 'opex',
  actual: 100, budget: variance === null ? null : 100 - variance, variance, variancePct: null,
  favourable: variance === null ? null : variance <= 0, budgetAboveFilter: false, fyBudgetAboveFilter: false,
  partialBudget: false, budgetVerdict: variance === null ? 'unbudgeted' : 'budgeted', monthly: [],
});
export const report = (over: Partial<BudgetTrackingReport> = {}): BudgetTrackingReport => ({
  window: { period: 'month', label: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30', months: ['2026-09'], fiscalYear: 2027, inProgress: null, postedThrough: '2026-09-30', notStarted: false },
  version: { id: 'v1', name: 'Original', kind: 'original', status: 'approved', isPrimary: true },
  filter: {},
  projection: { fiscalYear: 2027, cutoff: '2026-09-30', actualMonths: [], budgetMonths: [], judgedThrough: '2026-09' },
  lines: [line('6000', 50), line('6100', -80), line('6200', null)],
  bands: [band('revenue', 'Turnover', 1500, 1000), band('net_profit', 'Net profit', 300, null)],
  notices: { unbudgetedCount: 1, unbudgetedActual: { income: 0, expense: 100 }, unallocatedBudget: null, noVersion: false, partialBudget: null, noVersionYears: [], noBudgetAtFilterYears: [] },
  years: [],
  ...over,
});

/** The ledger aggregate of a window, by its start date: pack month, prior month, same month last year. */
export const AGGS: Record<string, Record<string, string>> = {
  '2026-09-01': { revenue: '1500.00', cogs: '400.00', net_profit: '300.00' },
  '2026-08-01': { revenue: '1200.00', cogs: '300.00', net_profit: '250.00' },
  '2025-09-01': { revenue: '900.00', cogs: '100.00', net_profit: '200.00' },
};

export const config = (mode: ManagementPackConfig['comparisonMode'], sections: string[]): ManagementPackConfig => ({
  id: 'c', companyId: 'co', enabled: true, generationDay: 5, deliveryDay: 10, reviewRequired: true,
  sectionsEnabled: Object.fromEntries(sections.map((s) => [s, true])),
  recipients: [], packStyle: 'detailed', comparisonMode: mode, currencyDisplay: 'full',
});

export async function generateWith(updateSection: Mock, mode: ManagementPackConfig['comparisonMode'], sections: string[]): Promise<Record<string, NoteContent>> {
  await generateManagementPack({ companyId: 'co', period: '2026-09', config: config(mode, sections), triggeredBy: 'manual' });
  const out: Record<string, NoteContent> = {};
  for (const [id, , , patch] of updateSection.mock.calls as [string, string, string, { content?: NoteContent }][]) {
    if (patch.content) out[id] = patch.content;
  }
  return out;
}
/** formatMoney groups with a no-break space. */
export const plain = (s: string) => s.replace(/\u00A0/g, ' ');
export const table = (c: NoteContent | undefined, n = 0): NoteContentTable => {
  const t = c?.blocks.filter((b): b is NoteContentTable => b.type === 'table')[n];
  if (!t) throw new Error(`no table ${n}`);
  return { ...t, rows: t.rows.map((r) => r.map(plain)) };
};
export const texts = (c: NoteContent | undefined) => (c?.blocks ?? []).flatMap((b) => (b.type === 'paragraph' ? [plain(b.text)] : []));
