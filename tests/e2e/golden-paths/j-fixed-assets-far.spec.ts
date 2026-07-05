/**
 * Golden path (j): fixed assets — register → depreciation run → FAR report
 * returns rows.
 *
 * Was EXPECTED FAIL at baseline — July-4 audit H5: far-report joined
 * c.company_id on asset_categories (42703) and masked every failure as
 * "run pending migrations". Flipped to a plain test by P1.5: the parallel
 * session fixed the join + made the catch honest; this branch fixed the
 * three remaining root causes — entry_number VARCHAR(20) overflow (every
 * depreciation GL post 22001'd on 'DEP-ASST-00NN-YYYY-MM', mig 500 widens
 * to 50), the unsavepointed per-asset loop (one bad asset poisoned the
 * request tx → 500), and a stray a.tax_life_years reference in the FAR
 * SELECT (column exists only on asset_categories).
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('fixed assets: register → depreciation run → FAR report has rows', async ({ baseURL }) => {
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
