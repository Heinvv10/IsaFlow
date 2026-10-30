/**
 * The Budget vs Actual controls, pure (budgets P3 spec §2.2, §2.5; review r1 TDD M3, arch L4/L5):
 * each explicit level is its own parameter; another window drops the chosen version; the page
 * URL round-trips the controls.
 */
import { describe, expect, it } from 'vitest';
import {
  controlsFromQuery, controlsToQuery, DEFAULT_CONTROLS, trackingSearch, withPatch,
} from '@/components/accounting/budgets/tracking/trackingControls';

const CC1 = '11111111-1111-4111-8111-111111111111';
const CC2 = '22222222-2222-4222-8222-222222222222';
const BU = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const q = (p: URLSearchParams) => Object.fromEntries(p);

describe('trackingSearch', () => {
  it.each([
    [{ cc1Id: CC1 }, { cc1_id: CC1 }],
    [{ cc2Id: CC2 }, { cc2_id: CC2 }],
    [{ buId: BU }, { bu_id: BU }],
    [{ cc2Id: CC2, buId: BU }, { cc2_id: CC2, bu_id: BU }],
  ])('a filter %j is its own explicit-level parameter, and no group_by', (filter, params) => {
    expect(q(trackingSearch({ ...DEFAULT_CONTROLS, ...filter }, { bullets: true }))).toEqual({ period: 'ytd', ...params });
  });

  it('sends the version when one is chosen', () => {
    expect(q(trackingSearch({ ...DEFAULT_CONTROLS, versionId: V }, { bullets: false }))).toEqual({ period: 'ytd', version_id: V });
  });
});

describe('withPatch', () => {
  const chosen = { ...DEFAULT_CONTROLS, fiscalYear: 2027, versionId: V };
  it.each([
    [{ period: 'fy' as const }], [{ fiscalYear: 2028 }], [{ quarter: 2 }], [{ month: '2026-08' }], [{ from: '2026-01' }], [{ to: '2026-09' }],
  ])('another window (%j) drops the chosen version', (patch) => {
    expect(withPatch(chosen, patch).versionId).toBe('');
  });

  it('a filter, the bullets or the same window keep it', () => {
    expect(withPatch(chosen, { cc1Id: CC1 }).versionId).toBe(V);
    expect(withPatch(chosen, { groupBy: 'bu' }).versionId).toBe(V);
    expect(withPatch(chosen, { fiscalYear: 2027 }).versionId).toBe(V);
  });
});

describe('the page URL', () => {
  it('round-trips every period with its own parameters', () => {
    for (const c of [
      { ...DEFAULT_CONTROLS, period: 'month' as const, month: '2026-08', cc2Id: CC2 },
      { ...DEFAULT_CONTROLS, period: 'quarter' as const, fiscalYear: 2026, quarter: 5, versionId: V },
      { ...DEFAULT_CONTROLS, period: 'custom' as const, from: '2026-01', to: '2026-05', buId: BU, groupBy: 'bu' as const },
      { ...DEFAULT_CONTROLS, period: 'fy' as const, fiscalYear: 2027, cc1Id: CC1 },
    ]) expect(controlsFromQuery(controlsToQuery(c))).toEqual(c);
  });

  it('a chosen financial year is kept under any period (it applies again on switching back; review r2 N3); other off-period parameters are not', () => {
    expect(controlsFromQuery({ period: 'month', fiscal_year: '2026', quarter: '3', from: '2026-01', to: '2026-02' }))
      .toEqual({ ...DEFAULT_CONTROLS, period: 'month', fiscalYear: 2026 });
    expect(controlsToQuery({ ...DEFAULT_CONTROLS, period: 'month', fiscalYear: 2026 })).toEqual({ period: 'month', fiscal_year: '2026' });
    // The REQUEST still carries only what the period takes.
    expect(Object.fromEntries(trackingSearch({ ...DEFAULT_CONTROLS, period: 'month', fiscalYear: 2026 }, { bullets: false }))).toEqual({ period: 'month' });
  });

  it('a custom window without both months falls back to the default period', () => {
    expect(controlsFromQuery({ period: 'custom', from: '2026-01' }).period).toBe('ytd');
  });
});
