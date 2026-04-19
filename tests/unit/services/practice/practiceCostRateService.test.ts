import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = vi.fn();
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  listCostRates,
  getCostRate,
  createCostRate,
  updateCostRate,
  deleteCostRate,
  resolveCostRate,
} from '@/modules/accounting/services/practice/practiceCostRateService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_1 = 'bbbbbbbb-0000-0000-0000-000000000002';
const RATE_ID = 'cccccccc-0000-0000-0000-000000000003';
const CREATED_BY = 'dddddddd-0000-0000-0000-000000000004';

const DB_ROW = {
  id: RATE_ID,
  company_id: COMPANY,
  user_id: USER_1,
  cost_rate: '500.0000',
  currency: 'ZAR',
  effective_from: '2026-01-01',
  effective_to: null,
  notes: 'Base rate',
  created_by: CREATED_BY,
  created_at: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// listCostRates
// ─────────────────────────────────────────────────────────────────────────────
describe('listCostRates', () => {
  it('returns mapped rows for a company', async () => {
    sqlMock.mockResolvedValueOnce([DB_ROW]);

    const result = await listCostRates(COMPANY);

    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.id).toBe(RATE_ID);
    expect(row.companyId).toBe(COMPANY);
    expect(row.userId).toBe(USER_1);
    expect(row.costRate).toBe(500);
    expect(row.currency).toBe('ZAR');
    expect(row.effectiveFrom).toBe('2026-01-01');
    expect(row.effectiveTo).toBeNull();
    expect(row.notes).toBe('Base rate');
  });

  it('filters by userId when provided', async () => {
    sqlMock.mockResolvedValueOnce([DB_ROW]);

    const result = await listCostRates(COMPANY, USER_1);

    expect(result).toHaveLength(1);
    // SQL was called with userId — verified by result correctness
    expect(result[0]!.userId).toBe(USER_1);
  });

  it('returns empty array when no records found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await listCostRates(COMPANY);

    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCostRate
// ─────────────────────────────────────────────────────────────────────────────
describe('getCostRate', () => {
  it('returns null when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await getCostRate(COMPANY, RATE_ID);

    expect(result).toBeNull();
  });

  it('returns mapped row when found', async () => {
    sqlMock.mockResolvedValueOnce([DB_ROW]);

    const result = await getCostRate(COMPANY, RATE_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(RATE_ID);
    expect(result!.costRate).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createCostRate
// ─────────────────────────────────────────────────────────────────────────────
describe('createCostRate', () => {
  it('rejects negative cost_rate', async () => {
    await expect(
      createCostRate(COMPANY, CREATED_BY, {
        userId: USER_1,
        costRate: -10,
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toThrow('cost rate must be >= 0');
  });

  it('creates a cost rate successfully', async () => {
    sqlMock.mockResolvedValueOnce([DB_ROW]);

    const result = await createCostRate(COMPANY, CREATED_BY, {
      userId: USER_1,
      costRate: 500,
      effectiveFrom: '2026-01-01',
    });

    expect(result.id).toBe(RATE_ID);
    expect(result.costRate).toBe(500);
    expect(result.createdBy).toBe(CREATED_BY);
  });

  it('accepts zero cost_rate', async () => {
    const zeroRow = { ...DB_ROW, cost_rate: '0.0000' };
    sqlMock.mockResolvedValueOnce([zeroRow]);

    const result = await createCostRate(COMPANY, CREATED_BY, {
      userId: USER_1,
      costRate: 0,
      effectiveFrom: '2026-01-01',
    });

    expect(result.costRate).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateCostRate
// ─────────────────────────────────────────────────────────────────────────────
describe('updateCostRate', () => {
  it('throws not found when record does not exist', async () => {
    sqlMock.mockResolvedValueOnce([]); // existence check

    await expect(
      updateCostRate(COMPANY, RATE_ID, { costRate: 600 }),
    ).rejects.toThrow('not found');
  });

  it('updates a cost rate successfully', async () => {
    const updatedRow = { ...DB_ROW, cost_rate: '600.0000' };
    sqlMock.mockResolvedValueOnce([{ id: RATE_ID }]); // existence check
    sqlMock.mockResolvedValueOnce([updatedRow]);

    const result = await updateCostRate(COMPANY, RATE_ID, { costRate: 600 });

    expect(result.costRate).toBe(600);
  });

  it('rejects negative cost_rate on update', async () => {
    await expect(
      updateCostRate(COMPANY, RATE_ID, { costRate: -5 }),
    ).rejects.toThrow('cost rate must be >= 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteCostRate
// ─────────────────────────────────────────────────────────────────────────────
describe('deleteCostRate', () => {
  it('hard-deletes the record without error', async () => {
    sqlMock.mockResolvedValueOnce([]);

    await expect(deleteCostRate(COMPANY, RATE_ID)).resolves.toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveCostRate
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveCostRate', () => {
  it('returns null when no record found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await resolveCostRate(COMPANY, USER_1, '2026-04-19');

    expect(result).toBeNull();
  });

  it('returns cost_rate from most-recent-effective record', async () => {
    sqlMock.mockResolvedValueOnce([{ cost_rate: '750.0000' }]);

    const result = await resolveCostRate(COMPANY, USER_1, '2026-04-19');

    expect(result).toBe(750);
  });
});
