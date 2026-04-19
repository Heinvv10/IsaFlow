import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import {
  listStaffRates,
  createStaffRate,
  updateStaffRate,
  resolveRate,
  listClientRateOverrides,
  createClientRateOverride,
} from '@/modules/accounting/services/practice/practiceStaffRateService';

const COMPANY   = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const CLIENT_ID = 'cccccccc-0000-0000-0000-000000000003';
const RATE_ID   = 'dddddddd-0000-0000-0000-000000000004';

const rateRow = {
  id: RATE_ID, company_id: COMPANY, user_id: USER_ID,
  rate: '850.00', currency: 'ZAR',
  effective_from: '2026-01-01', effective_to: null,
  created_at: new Date(),
};

beforeEach(() => vi.clearAllMocks());

describe('listStaffRates', () => {
  it('returns rates for a user', async () => {
    sqlMock.mockResolvedValueOnce([rateRow]);
    const result = await listStaffRates(COMPANY, USER_ID);
    expect(result[0]!.rate).toBe(850);
    expect(result[0]!.currency).toBe('ZAR');
  });
});

describe('createStaffRate', () => {
  it('inserts and returns staff rate', async () => {
    sqlMock.mockResolvedValueOnce([rateRow]);
    const result = await createStaffRate(COMPANY, {
      userId: USER_ID, rate: 850, currency: 'ZAR', effectiveFrom: '2026-01-01',
    });
    expect(result.rate).toBe(850);
  });
});

describe('updateStaffRate', () => {
  it('updates effective_to to close a rate', async () => {
    const closed = { ...rateRow, effective_to: '2026-03-31' };
    sqlMock.mockResolvedValueOnce([rateRow]).mockResolvedValueOnce([closed]);
    const result = await updateStaffRate(COMPANY, RATE_ID, { effectiveTo: '2026-03-31' });
    expect(result.effectiveTo).toBe('2026-03-31');
  });

  it('throws when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(updateStaffRate(COMPANY, RATE_ID, {})).rejects.toThrow('not found');
  });
});

describe('resolveRate', () => {
  it('returns client override rate when one exists', async () => {
    sqlMock.mockResolvedValueOnce([{ rate: '1200.00' }]);
    const rate = await resolveRate(COMPANY, USER_ID, CLIENT_ID, '2026-04-01');
    expect(rate).toBe(1200);
  });

  it('falls back to staff default when no client override', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ rate: '850.00' }]);
    const rate = await resolveRate(COMPANY, USER_ID, CLIENT_ID, '2026-04-01');
    expect(rate).toBe(850);
  });

  it('returns null when no rate configured at all', async () => {
    sqlMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const rate = await resolveRate(COMPANY, USER_ID, CLIENT_ID, '2026-04-01');
    expect(rate).toBeNull();
  });
});

describe('listClientRateOverrides', () => {
  it('returns overrides for a client', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'x', company_id: COMPANY, client_id: CLIENT_ID, user_id: USER_ID,
      rate: '1200.00', effective_from: '2026-01-01', effective_to: null, created_at: new Date(),
    }]);
    const result = await listClientRateOverrides(COMPANY, CLIENT_ID);
    expect(result[0]!.rate).toBe(1200);
  });
});

describe('createClientRateOverride', () => {
  it('inserts and returns override', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'x', company_id: COMPANY, client_id: CLIENT_ID, user_id: USER_ID,
      rate: '1200.00', effective_from: '2026-01-01', effective_to: null, created_at: new Date(),
    }]);
    const result = await createClientRateOverride(COMPANY, {
      clientId: CLIENT_ID, userId: USER_ID, rate: 1200, effectiveFrom: '2026-01-01',
    });
    expect(result.rate).toBe(1200);
  });
});
