// tests/unit/services/afs/managementPackConfigService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  getManagementPackConfig,
  upsertManagementPackConfig,
  getCompaniesScheduledForDate,
} from '@/modules/accounting/services/afs/managementPackConfigService';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const COMPANY_ID = 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb';

const DB_ROW = {
  id: 'row-id-1',
  company_id: COMPANY_ID,
  enabled: true,
  generation_day: 5,
  delivery_day: 10,
  review_required: true,
  sections_enabled: { cover: true, kpi_scorecard: true },
  recipients: [{ email: 'cfo@example.com', role: 'CFO', receives: 'both' }],
  pack_style: 'detailed',
  comparison_mode: 'prior_month',
  currency_display: 'full',
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-03-01'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getManagementPackConfig', () => {
  it('returns mapped camelCase config when row exists', async () => {
    mockSql.mockResolvedValueOnce([DB_ROW]);
    const config = await getManagementPackConfig(COMPANY_ID);
    expect(config.id).toBe('row-id-1');
    expect(config.companyId).toBe(COMPANY_ID);
    expect(config.enabled).toBe(true);
    expect(config.generationDay).toBe(5);
    expect(config.deliveryDay).toBe(10);
    expect(config.reviewRequired).toBe(true);
    expect(config.packStyle).toBe('detailed');
    expect(config.comparisonMode).toBe('prior_month');
    expect(config.currencyDisplay).toBe('full');
    expect(config.recipients).toHaveLength(1);
    expect(config.recipients[0]?.email).toBe('cfo@example.com');
  });

  it('returns default config when no row exists (empty array from DB)', async () => {
    mockSql.mockResolvedValueOnce([]);
    const config = await getManagementPackConfig(COMPANY_ID);
    expect(config.id).toBe('');
    expect(config.companyId).toBe(COMPANY_ID);
    expect(config.enabled).toBe(false);
    expect(config.generationDay).toBe(5);
    expect(config.deliveryDay).toBe(10);
    expect(config.packStyle).toBe('detailed');
    expect(config.recipients).toHaveLength(0);
  });

  it('default config has deliveryDay 10 and packStyle detailed (schema defaults)', async () => {
    mockSql.mockResolvedValueOnce([]);
    const config = await getManagementPackConfig(COMPANY_ID);
    expect(config.deliveryDay).toBe(10);
    expect(config.packStyle).toBe('detailed');
  });

  it('always scopes query to the specified companyId (no cross-tenant leak)', async () => {
    mockSql.mockResolvedValueOnce([DB_ROW]);
    await getManagementPackConfig(COMPANY_ID);
    // The sql call should have been made once with company_id filtering
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Verify the call includes the companyId value
    const callArgs = mockSql.mock.calls[0] as unknown[];
    // sql tagged template: first arg is TemplateStringsArray, rest are interpolated values
    const sqlValues = callArgs.slice(1);
    expect(sqlValues).toContain(COMPANY_ID);
  });
});

describe('upsertManagementPackConfig', () => {
  it('calls SQL ON CONFLICT upsert and returns updated config', async () => {
    // First call: getManagementPackConfig (reads existing)
    mockSql.mockResolvedValueOnce([DB_ROW]);
    // Second call: the upsert RETURNING *
    const updatedRow = { ...DB_ROW, delivery_day: 15 };
    mockSql.mockResolvedValueOnce([updatedRow]);

    const result = await upsertManagementPackConfig(COMPANY_ID, { deliveryDay: 15 });
    expect(result.deliveryDay).toBe(15);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('merges updates with existing config and calls upsert', async () => {
    mockSql.mockResolvedValueOnce([DB_ROW]);
    const updatedRow = { ...DB_ROW, enabled: false, generation_day: 10 };
    mockSql.mockResolvedValueOnce([updatedRow]);

    const result = await upsertManagementPackConfig(COMPANY_ID, { enabled: false, generationDay: 10 });
    expect(result.enabled).toBe(false);
    expect(result.generationDay).toBe(10);
    // Other fields remain from existing config
    expect(result.deliveryDay).toBe(10);
  });

  it('returns updated config after upsert', async () => {
    mockSql.mockResolvedValueOnce([]);  // getConfig returns default
    const newRow = {
      ...DB_ROW,
      id: 'new-row',
      enabled: true,
      pack_style: 'board',
    };
    mockSql.mockResolvedValueOnce([newRow]);

    const result = await upsertManagementPackConfig(COMPANY_ID, { enabled: true, packStyle: 'board' });
    expect(result.id).toBe('new-row');
    expect(result.enabled).toBe(true);
    expect(result.packStyle).toBe('board');
  });
});

describe('getCompaniesScheduledForDate', () => {
  it('returns only enabled companies scheduled for the given day', async () => {
    const row2 = { ...DB_ROW, company_id: 'company-2', generation_day: 5 };
    mockSql.mockResolvedValueOnce([DB_ROW, row2]);

    const result = await getCompaniesScheduledForDate(5);
    expect(result).toHaveLength(2);
    expect(result[0]?.companyId).toBe(COMPANY_ID);
    expect(result[1]?.companyId).toBe('company-2');
    expect(result[0]?.config.generationDay).toBe(5);
  });

  it('returns empty array when no companies are scheduled for the day', async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getCompaniesScheduledForDate(15);
    expect(result).toHaveLength(0);
  });

  it('includes both companyId and config in each result', async () => {
    mockSql.mockResolvedValueOnce([DB_ROW]);
    const result = await getCompaniesScheduledForDate(5);
    expect(result[0]).toHaveProperty('companyId');
    expect(result[0]).toHaveProperty('config');
    expect(result[0]?.config.packStyle).toBe('detailed');
  });
});
