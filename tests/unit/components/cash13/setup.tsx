/**
 * Shared mocks for the 13-week page tests: the client (every fetcher a vi.fn), the role, the router, the chart
 * and the layout. Each test file calls `vi.mock` with these factories (vi.mock is hoisted per file).
 */
import { vi } from 'vitest';
import type { ReactNode } from 'react';
import { forecastFixture, TODAY } from './fixture';

export const client = {
  fetchForecast: vi.fn(),
  fetchOverrides: vi.fn(),
  fetchItems: vi.fn(),
  fetchPayDay: vi.fn(),
  saveOverride: vi.fn(),
  deleteOverride: vi.fn(),
  createItem: vi.fn(),
  deleteItem: vi.fn(),
  savePayDay: vi.fn(),
};

export const role = { current: 'owner' as string | null };
export const router = { query: {} as Record<string, string>, pathname: '/accounting/reports/cash-flow-forecast', replace: vi.fn(async () => true), push: vi.fn(), isReady: true };

export const companyModule = () => ({ useCompany: () => ({ companyRole: role.current, activeCompany: { id: 'c1' } }) });
export const routerModule = () => ({ useRouter: () => router });
export const layoutModule = () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> });
export const chartModule = () => ({ ChartFrame: ({ title, summary }: { title: string; summary?: string }) => <div role="img" aria-label={summary}>{title}</div> });

export const ok = <T,>(data: T) => ({ ok: true as const, data });
export const notFound = { ok: false as const, kind: 'notFound' as const, message: 'Not found' };

export const OVERRIDE_ID = '22222222-2222-4222-8222-222222222222';

/** Every fetch answers: the fixture, no overrides, no items, the default pay day. */
export function answerDefaults(): void {
  client.fetchForecast.mockReset().mockResolvedValue(ok(forecastFixture({ overrides: [] })));
  client.fetchOverrides.mockReset().mockResolvedValue(ok([]));
  client.fetchItems.mockReset().mockResolvedValue(ok([]));
  client.fetchPayDay.mockReset().mockResolvedValue(ok({ payDay: { kind: 'day_of_month', day: 25 }, day: 25, isDefault: true }));
  for (const w of [client.saveOverride, client.deleteOverride, client.createItem, client.deleteItem, client.savePayDay]) w.mockReset().mockResolvedValue(ok({}));
  role.current = 'owner';
  router.query = {};
}

export { TODAY };
