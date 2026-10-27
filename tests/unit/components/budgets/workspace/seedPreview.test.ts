import { expect, it } from 'vitest';
import { priorFigures, pySeedFigures, versionSeedFigures, type PreviewAccount } from '@/components/accounting/budgets/workspace/seedPreview';
import { buildSeedRequest, defaultDraft, parsePct, stepError } from '@/components/accounting/budgets/workspace/wizardDraft';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';

const S = 's', C = 'c', H = 'h', X = 'x';
const acc = (id: string, band: PreviewAccount['band'], over: Partial<PreviewAccount> = {}): PreviewAccount => ({ id, band, isActive: true, isHeader: false, ...over });
const ACCOUNTS = [acc(S, 'turnover'), acc(C, 'cost_of_sales'), acc(H, 'turnover', { isHeader: true }), acc(X, 'operating_expense', { isActive: false })];
const months = ['2027-01', '2027-02', '2027-03'];
const cell = (glAccountId: string, month: string, amount: number, dimensionId: string | null = null) => ({ glAccountId, dimensionId, month, amount });
const prior = (cells: PriorActuals['cells'], grain: PriorActuals['grain'] = 'company'): PriorActuals =>
  ({ fiscalYear: 2027, grain, months, priorMonths: months, cells });
const OPT = { grain: 'company', unassigned: 'company', includeNoActivity: false, pct: 0, unit: 1 } as const;
const figs = (r: ReturnType<typeof pySeedFigures>) => { if (!r.ok) throw new Error(r.reason); return r.figures; };

it('prior figures are the posted actuals in cents, headers and inactive accounts included', () => {
  const f = priorFigures(ACCOUNTS, prior([cell(S, '2027-01', 100), cell(C, '2027-01', 40), cell(H, '2027-01', 10), cell(X, '2027-01', 5)]));
  expect(f).toEqual({ turnover: 11000, grossProfit: 7000, netProfit: 6500 });
});

it('PY seed: +10% rounded to R100 puts the residue on the last month and skips headers and inactive accounts', () => {
  const cells = [cell(S, '2027-01', 1000), cell(S, '2027-02', 1000), cell(S, '2027-03', 1050), cell(H, '2027-01', 999), cell(X, '2027-01', 999)];
  // target = roundToUnit(3050 * 1.1 = 3355) = 3400 (R100); months 1100, 1100, residue 1200 (the sum is 3400)
  expect(figs(pySeedFigures(ACCOUNTS, prior(cells), { ...OPT, pct: 10, unit: 100 })).turnover).toBe(340000);
});

it('PY seed at a dimension grain: unassigned "company" sums the account, "drop" keeps only tagged series', () => {
  const cells = [cell(S, '2027-01', 300, 'cc-1'), cell(S, '2027-02', 100, null)];
  const keep = figs(pySeedFigures(ACCOUNTS, prior(cells, 'cc1'), { ...OPT, grain: 'cc1', unassigned: 'company' }));
  const drop = figs(pySeedFigures(ACCOUNTS, prior(cells, 'cc1'), { ...OPT, grain: 'cc1', unassigned: 'drop' }));
  expect(keep.turnover).toBe(40000);
  expect(drop.turnover).toBe(30000);
});

it('PY seed refuses an uplift outside -100..1000 with the reason', () => {
  const r = pySeedFigures(ACCOUNTS, prior([cell(S, '2027-01', 100)]), { ...OPT, pct: 2000 });
  expect(r.ok).toBe(false);
});

it('version copy maps months by position and puts the residue on the last budgeted month', () => {
  const src = ['2026-01', '2026-02', '2026-03'];
  const cells = [{ glAccountId: S, cc1Id: null, cc2Id: null, buId: null, month: '2026-01', amount: 100 }, { glAccountId: S, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 300 }];
  const r = versionSeedFigures(ACCOUNTS, cells, src, 3, 50, 1);
  expect(r.ok && r.figures.turnover).toBe(60000);
});

it('wizard draft: a name is required, the uplift must be in range, and Import Excel seeds a blank version', () => {
  const d = defaultDraft({ fiscalYear: 2027, hasVersions: false });
  expect(stepError(d, 0, true)).toMatch(/name/);
  expect(stepError({ ...d, name: 'B', upliftPct: '1001' }, 1, true)).toMatch(/uplift/);
  expect(parsePct('-100')).toBe(-100);
  expect(parsePct('7,5')).toBe(7.5);
  expect(parsePct('abc')).toBeNull();
  expect(buildSeedRequest({ ...d, name: ' B ', source: 'import' }).source).toEqual({ type: 'blank' });
});
