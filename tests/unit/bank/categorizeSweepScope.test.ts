/**
 * The smart-categorize sweep's scope (Hein, 2026-10-21, decision 2): recent, uncoded lines only, bounded
 * per run, limits from env with safe defaults. The selector's SQL runs against a real schema in
 * tests/integration/categorize-sweep-scope.int.test.ts; here, its shape and the values it binds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/codingDecisionLog', () => ({ recordSuggestionsShown: vi.fn(), recordAutoPosted: vi.fn() }));

import {
  categorizeSweepScope, CATEGORIZE_SWEEP_MAX_LINES_DEFAULT, CATEGORIZE_SWEEP_RECENT_DAYS_DEFAULT,
} from '@/modules/accounting/services/core/categorizeSweepScope';
import { selectSweepLineIds, smartCategorizeForAccount } from '@/modules/accounting/services/core/smartCategorizationService';

const CO = '00000000-0000-4000-8000-000000000001';
const BANK = '00000000-0000-4000-8000-0000000000aa';
const ENV = ['CATEGORIZE_SWEEP_RECENT_DAYS', 'CATEGORIZE_SWEEP_MAX_LINES'] as const;

beforeEach(() => { sqlMock.mockReset(); for (const k of ENV) delete process.env[k]; });
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('categorizeSweepScope', () => {
  it('defaults: 30 days, 200 lines', () => {
    expect(CATEGORIZE_SWEEP_RECENT_DAYS_DEFAULT).toBe(30);
    expect(CATEGORIZE_SWEEP_MAX_LINES_DEFAULT).toBe(200);
    expect(categorizeSweepScope()).toEqual({ recentDays: 30, maxLines: 200 });
  });
  it('env widens it', () => {
    process.env.CATEGORIZE_SWEEP_RECENT_DAYS = '90';
    process.env.CATEGORIZE_SWEEP_MAX_LINES = '500';
    expect(categorizeSweepScope()).toEqual({ recentDays: 90, maxLines: 500 });
  });
  it.each(['', '0', '-5', 'all'])('a bad env value (%j) falls back to the default', (v) => {
    process.env.CATEGORIZE_SWEEP_RECENT_DAYS = v;
    process.env.CATEGORIZE_SWEEP_MAX_LINES = v;
    expect(categorizeSweepScope()).toEqual({ recentDays: 30, maxLines: 200 });
  });
});

describe('selectSweepLineIds', () => {
  it('uncoded, recent, not in the decision log, newest first, bounded', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
    expect(await selectSweepLineIds(CO, BANK)).toEqual(['t1', 't2']);
    const text = (sqlMock.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/bt\.status = 'imported'/);
    expect(text).not.toMatch(/'allocated'/);
    expect(text).toMatch(/bt\.suggested_gl_account_id IS NULL\s+AND bt\.suggested_category IS NULL/);
    expect(text).toMatch(/bt\.transaction_date >= CURRENT_DATE - \?::INT\s+OR bt\.created_at >= now\(\) - make_interval\(days => \?::INT\)/);
    expect(text).toMatch(/NOT EXISTS \(\s+SELECT 1 FROM categorization_decisions cd\s+WHERE cd\.company_id = bt\.company_id AND cd\.bank_transaction_id = bt\.id/);
    expect(text).toMatch(/ORDER BY bt\.transaction_date DESC, bt\.id\s+LIMIT \?/);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, BANK, 30, 30, 200]);
  });
  it('binds the env scope', async () => {
    process.env.CATEGORIZE_SWEEP_RECENT_DAYS = '7';
    process.env.CATEGORIZE_SWEEP_MAX_LINES = '50';
    sqlMock.mockResolvedValueOnce([]);
    await selectSweepLineIds(CO, BANK);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, BANK, 7, 7, 50]);
  });
});

describe('smartCategorizeForAccount', () => {
  it('nothing in scope: no categorize queries at all', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect(await smartCategorizeForAccount(CO, BANK)).toEqual({ categorized: 0, skipped: 0, results: [] });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
