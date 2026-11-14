/**
 * Audit 2026-11-14 item 1.1: Churn Signals listed every company as "0d, Never". A company none of whose members
 * ever signed in has no inactivity age: the service must answer null, not 0, so the page can say "Never".
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const CHURN = [
  { company_id: 'c-never', company_name: 'Never Co', days_inactive: null, last_login: null },
  { company_id: 'c-old', company_name: 'Old Co', days_inactive: 20, last_login: new Date('2026-10-25T08:00:00Z') },
  { company_id: 'c-today', company_name: 'Edge Co', days_inactive: 0, last_login: new Date('2026-11-14T08:00:00Z') },
];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (/days_inactive/.test(text)) return CHURN;
    return [{ dau: '0', wau: '0', mau: '0', total: '1' }];
  }),
}));

import { getUsageAnalytics } from '@/modules/admin/services/analyticsService';

describe('getUsageAnalytics churn signals', () => {
  it('never signed in: days_inactive and last_login are null; a real 0-day gap stays 0', async () => {
    const { churn_signals } = await getUsageAnalytics();
    expect(churn_signals).toEqual([
      { company_id: 'c-never', company_name: 'Never Co', days_inactive: null, last_login: null },
      { company_id: 'c-old', company_name: 'Old Co', days_inactive: 20, last_login: '2026-10-25T08:00:00.000Z' },
      { company_id: 'c-today', company_name: 'Edge Co', days_inactive: 0, last_login: '2026-11-14T08:00:00.000Z' },
    ]);
  });
});
