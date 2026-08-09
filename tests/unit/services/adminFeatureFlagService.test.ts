/**
 * Unit tests for featureFlagService.getCompanyEffectiveFeatures.
 *
 * Contract the admin UI depends on: every returned row carries the feature's
 * `id`. Without it the admin Features tab posts `feature_id: undefined`,
 * JSON.stringify drops the key, and the override endpoint 400s — which
 * presented as toggles that silently did nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getCompanyEffectiveFeatures } from '@/modules/admin/services/featureFlagService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GLOBAL_ID = '11111111-1111-1111-1111-111111111111';
const PLAN_ID = '22222222-2222-2222-2222-222222222222';
const OVERRIDE_ID = '33333333-3333-3333-3333-333333333333';
const OFF_ID = '44444444-4444-4444-4444-444444444444';

/** flags query → plan query → overrides query, in the order the service issues them. */
function mockQueries(): void {
  vi.mocked(sql)
    .mockResolvedValueOnce([
      { id: GLOBAL_ID, code: 'core_accounting', name: 'Core Accounting', is_global: true },
      { id: PLAN_ID, code: 'payroll', name: 'Payroll', is_global: false },
      { id: OVERRIDE_ID, code: 'mcp_connector', name: 'MCP Connector (AI agents)', is_global: false },
      { id: OFF_ID, code: 'multi_company', name: 'Multi-Company', is_global: false },
    ] as never)
    .mockResolvedValueOnce([{ feature_id: PLAN_ID }] as never)
    .mockResolvedValueOnce([{ feature_id: OVERRIDE_ID, enabled: true }] as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCompanyEffectiveFeatures', () => {
  it('returns the feature id on every row — the admin toggle posts it as feature_id', async () => {
    mockQueries();

    const features = await getCompanyEffectiveFeatures(COMPANY);

    expect(features.map((f) => f.id)).toEqual([GLOBAL_ID, PLAN_ID, OVERRIDE_ID, OFF_ID]);
    for (const feature of features) {
      expect(feature.id).toBeTruthy();
      // The exact failure that broke the UI: an undefined id vanishes from the
      // request body, because JSON.stringify omits undefined values.
      expect(JSON.parse(JSON.stringify({ feature_id: feature.id }))).toHaveProperty('feature_id');
    }
  });

  it('resolves enabled/source precedence: override > global > plan', async () => {
    mockQueries();

    const byCode = Object.fromEntries(
      (await getCompanyEffectiveFeatures(COMPANY)).map((f) => [f.code, f]),
    );

    expect(byCode.core_accounting).toMatchObject({ enabled: true, source: 'global' });
    expect(byCode.payroll).toMatchObject({ enabled: true, source: 'plan' });
    expect(byCode.mcp_connector).toMatchObject({ enabled: true, source: 'override' });
    expect(byCode.multi_company).toMatchObject({ enabled: false, source: 'plan' });
  });

  it('scopes the plan and override lookups to the requested company', async () => {
    mockQueries();

    await getCompanyEffectiveFeatures(COMPANY);

    // Per query, not flattened across all three — a flattened check would still
    // pass if the company filter landed on the wrong statement.
    const [flagsQuery, planQuery, overridesQuery] = vi.mocked(sql).mock.calls;
    expect(flagsQuery.slice(1)).toEqual([]); // catalogue query is tenant-agnostic
    expect(planQuery.slice(1)).toEqual([COMPANY]);
    expect(overridesQuery.slice(1)).toEqual([COMPANY]);
  });
});
