/**
 * Budgets P2 PR-B, the grid read model's tenant isolation (spec 4.2, 4.3): through the route under
 * RLS and through the service on a superuser connection, where only the query's own company_id
 * protects. The world (companies A, B, T) is helpers/budgetGridReadWorld.ts; the rest of the read
 * model is budget-grid-read.int.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { GridCo } from './helpers/budgetGridFixture';
import { budgetGridReadWorld, data } from './helpers/budgetGridReadWorld';

assertDisposable();
const { get, direct, w } = budgetGridReadWorld();
let B: GridCo;
let primary: string;
beforeAll(() => { ({ B, primary } = w); });

describe('budget-grid read model: tenant isolation', () => {
  it('another tenant\'s version id is a 404, and the same year answers only the caller\'s own figures', async () => {
    const r = await get(B, { version_id: primary });
    expect(r.status).toBe(404);
    expect(r.body.error?.details?.code).toBe('BUDGET_VERSION_NOT_FOUND');
    const own = data<GridReadModel>(await get(B, { fiscal_year: '2027' }));
    expect(own.cells.map((c) => c.amount)).toEqual([3]);
    expect(own.accounts.every((x) => Object.values(B.acct).includes(x.id))).toBe(true);
  });

  it('the service alone (no RLS) lists only the caller\'s accounts, members and cells', async () => {
    const m = await direct(B, { fiscalYear: 2027 });
    expect(m.cells.map((c) => c.glAccountId)).toEqual([B.acct.sales]);
    expect(m.accounts.every((x) => Object.values(B.acct).includes(x.id))).toBe(true);
    expect(m.accounts.length).toBeGreaterThan(0);
    const members = [...m.dimensions.cc1, ...m.dimensions.cc2, ...m.dimensions.bu].map((x) => x.id);
    expect(members.every((id) => [B.cc1, B.cc1b, B.cc2, B.bu].includes(id))).toBe(true);
    expect(m.totals.fy.turnover).toBe(3);
  });

  it('the newest-version fallback never reaches another tenant\'s versions', async () => {
    // A has FY2028 versions and no primary; B has none: B must see no version, not A's newest.
    const m = await direct(B, { fiscalYear: 2028 });
    expect(m.version).toBeNull();
    expect(m.cells).toEqual([]);
    expect(m.accounts.length).toBeGreaterThan(0);
    expect(m.accounts.every((x) => Object.values(B.acct).includes(x.id))).toBe(true);
  });

  it('the service refuses another tenant\'s version id', async () => {
    await expect(direct(B, { versionId: primary })).rejects.toMatchObject({ code: 'BUDGET_VERSION_NOT_FOUND' });
  });
});
