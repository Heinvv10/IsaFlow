/**
 * Every write of the 13-week cash forecast's data layer refuses a Login-as session before any SQL
 * (R-032 L5, as markFiled does).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(() => Promise.resolve([])), { unsafe: vi.fn((s: string) => s) }),
  withSavepoint: vi.fn((_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
class ImpersonationForbiddenError extends Error {}
vi.mock('@/lib/auth/impersonationGuard', () => ({
  assertNotImpersonating: vi.fn(async () => { throw new ImpersonationForbiddenError('Login-as'); }),
}));

import { sql } from '@/lib/neon';
import { createItem, deleteItem, updateItem } from '@/modules/accounting/services/cashForecast13/itemsRepo';
import { deleteOverride, saveOverride } from '@/modules/accounting/services/cashForecast13/overridesRepo';
import { setPayDay } from '@/modules/accounting/services/cashForecast13/payDaySetting';

const CO = 'aaaaaaaa-0000-0000-0000-0000000000c1';
const ID = 'aaaaaaaa-0000-0000-0000-0000000000d1';
const ITEM = { direction: 'receipt' as const, amount: 1, date: '2026-12-01', repeat: 'none' as const, repeatUntil: null, description: 'x', accountId: null };
const OVR = { lineKey: 'payroll:net', weekStart: '2026-11-16', mode: 'set' as const, amount: 0, targetWeekStart: null, note: null };

describe('a Login-as session is refused before any SQL', () => {
  // The module-level column fragments are sql calls made at import; count only the calls a write makes.
  beforeEach(() => { vi.mocked(sql).mockClear(); });

  it.each([
    ['createItem', () => createItem(CO, 'u1', ITEM)],
    ['updateItem', () => updateItem(CO, 'u1', ID, ITEM)],
    ['deleteItem', () => deleteItem(CO, 'u1', ID)],
    ['saveOverride', () => saveOverride(CO, 'u1', OVR)],
    ['deleteOverride', () => deleteOverride(CO, 'u1', ID)],
    ['setPayDay', () => setPayDay(CO, 'u1', { kind: 'day_of_month', day: 25 })],
  ])('%s', async (_n, call) => {
    await expect(call()).rejects.toBeInstanceOf(ImpersonationForbiddenError);
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });
});
