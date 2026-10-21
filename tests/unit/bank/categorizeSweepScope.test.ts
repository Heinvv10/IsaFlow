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
import {
  markAttempted, MAX_ATTEMPTS_PER_ACCOUNT, recentlyAttempted, resetSweepAttempts,
} from '@/modules/accounting/services/core/categorizeSweepAttempts';

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
    expect(text).toMatch(/bt\.transaction_date >= \(now\(\) AT TIME ZONE 'Africa\/Johannesburg'\)::date - \?::INT\s+OR bt\.created_at >= now\(\) - make_interval\(days => \?::INT\)/);
    expect(text).toMatch(/NOT EXISTS \(\s+SELECT 1 FROM categorization_decisions cd\s+WHERE cd\.company_id = bt\.company_id AND cd\.bank_transaction_id = bt\.id/);
    expect(text).toMatch(/ORDER BY \(bt\.id = ANY\(\?::uuid\[\]\)\), bt\.transaction_date DESC, bt\.id\s+LIMIT \?/);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, BANK, 30, 30, [], 200]);
  });
  it('binds the env scope', async () => {
    process.env.CATEGORIZE_SWEEP_RECENT_DAYS = '7';
    process.env.CATEGORIZE_SWEEP_MAX_LINES = '50';
    sqlMock.mockResolvedValueOnce([]);
    await selectSweepLineIds(CO, BANK);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, BANK, 7, 7, [], 50]);
  });
});

describe('smartCategorizeForAccount', () => {
  it('nothing in scope: no categorize queries at all', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect(await smartCategorizeForAccount(CO, BANK))
      .toEqual({ categorized: 0, skipped: 0, results: [], firstAttemptTxIds: [] });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

describe('lines a sweep already tried (categorizeSweepAttempts.ts)', () => {
  const OTHER_BANK = '00000000-0000-4000-8000-0000000000bb';
  const H = 3_600_000;
  beforeEach(() => { resetSweepAttempts(); delete process.env.CATEGORIZE_SWEEP_RETRY_HOURS; });

  it('the next sweep binds the tried lines so they sort last, and only untried lines are first attempts', async () => {
    sqlMock.mockResolvedValue([]);
    sqlMock.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
    expect((await smartCategorizeForAccount(CO, BANK)).firstAttemptTxIds).toEqual(['t1', 't2']);
    sqlMock.mockClear();
    sqlMock.mockResolvedValueOnce([{ id: 't3' }, { id: 't1' }]);
    expect((await smartCategorizeForAccount(CO, BANK)).firstAttemptTxIds).toEqual(['t3']);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual([CO, BANK, 30, 30, ['t1', 't2'], 200]);
  });

  it('per bank account and company', () => {
    markAttempted(CO, BANK, ['t1']);
    expect(recentlyAttempted(CO, OTHER_BANK)).toEqual([]);
    expect(recentlyAttempted('00000000-0000-4000-8000-000000000002', BANK)).toEqual([]);
  });

  it('forgotten after the retry window (CATEGORIZE_SWEEP_RETRY_HOURS, default 24)', () => {
    const t0 = 1_000_000_000_000;
    markAttempted(CO, BANK, ['t1'], t0);
    markAttempted(CO, BANK, ['t2'], t0 + 12 * H);
    expect(recentlyAttempted(CO, BANK, t0 + 23 * H)).toEqual(['t1', 't2']);
    expect(recentlyAttempted(CO, BANK, t0 + 24 * H)).toEqual(['t2']);
    process.env.CATEGORIZE_SWEEP_RETRY_HOURS = '1';
    expect(markAttempted(CO, BANK, ['t2'], t0 + 13 * H)).toEqual(['t2']);
  });

  it('bounded per account, oldest dropped', () => {
    const ids = Array.from({ length: MAX_ATTEMPTS_PER_ACCOUNT + 3 }, (_, i) => `t${i}`);
    markAttempted(CO, BANK, ids);
    const kept = recentlyAttempted(CO, BANK);
    expect(kept).toHaveLength(MAX_ATTEMPTS_PER_ACCOUNT);
    expect(kept[0]).toBe('t3');
  });
});
