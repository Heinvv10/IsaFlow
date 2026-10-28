/**
 * BudgetWorkspace tests: the network edge (global `fetch`, under the real apiFetch and fetchers)
 * as a route table, with the year list, versions list, read model, prior actuals and the density
 * preference answered by default. Each test file mocks `@/contexts/CompanyContext` (role) and
 * `next/router` itself (vi.mock is hoisted per file).
 */
import { vi } from 'vitest';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { MONTHS, gridModel } from './gridFixture';

export type Reply = (url: string, body: unknown) => Response | Promise<Response>;
interface Route { match: (url: string, method: string) => boolean; reply: Reply }

export const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
export const fail = (status: number, message: string, details?: unknown) =>
  new Response(JSON.stringify({ success: false, error: { code: 'X', message, details } }), { status });

export const isModel = (url: string) => url.startsWith('/api/accounting/budget-grid?') && !url.includes('cells_only');
export const isSave = (url: string) => url === '/api/accounting/budget-grid/save';

const year = (fy: number) => ({ fiscalYear: fy, startDate: `${fy - 1}-03-01`, endDate: `${fy}-02-28`, kind: 'normal', monthKeys: fy === 2027 ? MONTHS : [] });

export function modelFor(fy: number, over: Partial<GridReadModel> = {}): GridReadModel {
  const base = gridModel();
  return { ...base, year: { ...base.year, fiscalYear: fy }, version: base.version && { ...base.version, fiscalYear: fy }, ...over };
}

export function installNetwork() {
  const routes: Route[] = [];
  const sent: Array<{ url: string; method: string; body: unknown }> = [];
  const on = (match: Route['match'], reply: Reply) => { routes.unshift({ match, reply }); };
  on(() => true, (url) => { throw new Error(`unexpected ${url}`); });
  on((u) => u.startsWith('/api/auth/preferences'), () => ok({}));
  on((u) => u === '/api/accounting/budgets', () => ok({ items: [], fiscalYear: 2027, year: year(2027), years: [year(2026), year(2027), year(2028)] }));
  on((u) => u.startsWith('/api/accounting/budget-versions?fiscalYear='), (u) => {
    const fy = Number(u.split('=')[1]);
    const v = modelFor(fy).version!;
    return ok({ items: [v] });
  });
  on((u) => u.includes('/prior-actuals'), () => ok({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: MONTHS, cells: [] }));
  on(isModel, () => ok(gridModel()));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    sent.push({ url, method, body });
    return routes.find((r) => r.match(url, method))!.reply(url, body);
  }));
  return { on, sent };
}
