/**
 * Golden path (j): fixed assets — register → depreciation run → FAR report
 * returns rows.
 *
 * EXPECTED FAIL at baseline — July-4 audit H5: far-report joins
 * c.company_id on asset_categories (column doesn't exist → 42703), swallows
 * the error and answers "run pending migrations" with an empty register.
 * P1.5 fixes the join and makes the error honest.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('fixed assets: register → depreciation run → FAR report has rows', async ({ baseURL }) => {
  test.fail(true, 'AUDIT H5 (2026-07-04): far-report 42703 masked as "run pending migrations" — fixed by P1.5');

  const api = await Api.login(baseURL!);
  try {
    // Register an asset.
    const ref = gpRef('AST');
    const asset = await api.post<any>('/api/accounting/assets', {
      name: ref,
      cost: 12000,
      usefulLifeYears: 3,
      purchaseDate: today(),
      depreciationMethod: 'straight_line',
    });
    expect(asset.id).toBeTruthy();

    // Run depreciation (dual policy+tax engine; posts policy dep to GL).
    await api.post('/api/accounting/run-depreciation', {});

    // FAR report must return rows — never the misleading setup message.
    const far = await api.get<any>(`/api/accounting/assets/far-report?asAt=${today()}`);
    expect(
      far.setupRequired,
      'FAR must not claim "run pending migrations" when the tables exist',
    ).toBeFalsy();
    expect(Array.isArray(far.assets)).toBe(true);
    expect(far.assets.length, 'FAR must include the registered asset').toBeGreaterThan(0);
    const names = far.assets.map((a: any) => String(a.name ?? a.assetName ?? ''));
    expect(names.some((n: string) => n.includes(ref)), 'our asset appears in the FAR').toBe(true);
  } finally {
    await api.dispose();
  }
});
