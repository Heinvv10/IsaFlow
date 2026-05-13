// RED phase — written before implementation
/**
 * Unit tests for taxDirectiveService.ts and taxCalculations.ts
 *
 * Pure calculateLumpSumTax tests require no mocks.
 * DB-dependent functions (listTaxDirectives, createTaxDirective,
 * updateTaxDirectiveStatus) use a mocked sql tagged template.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { calculateLumpSumTax } from '@/lib/taxCalculations';
import {
  listTaxDirectives,
  createTaxDirective,
  updateTaxDirectiveStatus,
} from '@/modules/accounting/services/reports/taxDirectiveReportsService';
import type { TaxDirective, TaxDirectiveInput } from '@/modules/accounting/services/reports/taxDirectiveReportsService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const EMPLOYEE_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const USER_ID = 'cccccccc-0000-0000-0000-000000000003';
const DIRECTIVE_ID = 'dddddddd-0000-0000-0000-000000000004';

// ── Sample data ───────────────────────────────────────────────────────────────

const sampleDirective: TaxDirective = {
  id: DIRECTIVE_ID,
  company_id: COMPANY_ID,
  employee_id: EMPLOYEE_ID,
  employee_name: 'John Doe',
  employee_tax_number: '1234567890',
  directive_number: 'DIR-2026-001',
  directive_type: 'lump_sum',
  amount: 600_000,
  tax_rate: 0.18,
  tax_amount: 18_000,
  effective_date: '2026-04-01',
  expiry_date: '2026-12-31',
  status: 'pending',
  sars_reference: 'SARS-REF-001',
  notes: null,
  requested_by: USER_ID,
  approved_by: null,
  created_at: '2026-04-01T00:00:00.000Z',
  updated_at: '2026-04-01T00:00:00.000Z',
};

const sampleInput: TaxDirectiveInput = {
  employee_id: EMPLOYEE_ID,
  employee_name: 'John Doe',
  employee_tax_number: '1234567890',
  directive_number: 'DIR-2026-001',
  directive_type: 'lump_sum',
  amount: 600_000,
  tax_rate: 0.18,
  effective_date: '2026-04-01',
};

// ── calculateLumpSumTax — pure function, no mocks ─────────────────────────────

describe('calculateLumpSumTax — pure bracket calculation', () => {
  it('zero amount returns zero tax with zero effective rate', () => {
    const result = calculateLumpSumTax(0, null);
    expect(result.taxAmount).toBe(0);
    expect(result.effectiveRate).toBe(0);
    expect(result.directiveRateUsed).toBe(false);
  });

  it('R400k sits entirely in the 0% bracket — zero tax', () => {
    const result = calculateLumpSumTax(400_000, null);
    expect(result.taxAmount).toBe(0);
    expect(result.grossAmount).toBe(400_000);
    expect(result.effectiveRate).toBe(0);
  });

  it('R600k: 0% on first R500k, 18% on R100k above → R18,000 tax', () => {
    const result = calculateLumpSumTax(600_000, null);
    expect(result.taxAmount).toBe(18_000);
    // Effective rate: 18000 / 600000 = 0.03
    expect(result.effectiveRate).toBeCloseTo(0.03, 5);
    expect(result.directiveRateUsed).toBe(false);
  });

  it('R800k: 0% on R500k, 18% on R200k = R36k, 27% on R100k = R27k → R63,000 total', () => {
    const result = calculateLumpSumTax(800_000, null);
    expect(result.taxAmount).toBe(63_000);
    expect(result.effectiveRate).toBeCloseTo(63_000 / 800_000, 5);
  });

  it('R1.2M: traverses all four brackets to correct total', () => {
    // 0% on 500k = 0
    // 18% on 200k (500k–700k) = 36,000
    // 27% on 350k (700k–1,050k) = 94,500
    // 36% on 150k (1,050k–1,200k) = 54,000
    // total = 184,500
    const result = calculateLumpSumTax(1_200_000, null);
    expect(result.taxAmount).toBe(184_500);
    expect(result.breakdown).toHaveLength(4);
  });

  it('directive rate provided: uses flat rate and ignores brackets', () => {
    // R600k with directive rate 25% → tax = 150,000
    const result = calculateLumpSumTax(600_000, 0.25);
    expect(result.taxAmount).toBe(150_000);
    expect(result.effectiveRate).toBe(0.25);
    expect(result.directiveRateUsed).toBe(true);
    expect(result.breakdown).toHaveLength(1);
  });

  it('directive rate 0% overrides brackets and produces zero tax', () => {
    // A 0% SARS directive is valid — still uses directive path
    const result = calculateLumpSumTax(800_000, 0);
    expect(result.taxAmount).toBe(0);
    expect(result.directiveRateUsed).toBe(true);
  });

  it('effective rate is correct ratio of taxAmount to grossAmount', () => {
    const result = calculateLumpSumTax(700_000, null);
    // 18% on 200k = 36,000; effectiveRate = 36000/700000
    const expected = result.taxAmount / result.grossAmount;
    expect(result.effectiveRate).toBeCloseTo(expected, 5);
  });

  it('directiveRateUsed is false when null directive rate passed', () => {
    const result = calculateLumpSumTax(500_000, null);
    expect(result.directiveRateUsed).toBe(false);
  });

  it('directiveRateUsed is true when a positive directive rate is passed', () => {
    const result = calculateLumpSumTax(500_000, 0.20);
    expect(result.directiveRateUsed).toBe(true);
  });
});

// ── listTaxDirectives ─────────────────────────────────────────────────────────

describe('listTaxDirectives', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('returns mapped array scoped to companyId', async () => {
    vi.mocked(sql).mockResolvedValueOnce([sampleDirective]);

    const result = await listTaxDirectives(COMPANY_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: DIRECTIVE_ID, company_id: COMPANY_ID });
  });

  it('passes companyId as first interpolated argument', async () => {
    vi.mocked(sql).mockResolvedValueOnce([sampleDirective]);

    await listTaxDirectives(COMPANY_ID);

    const callArgs = vi.mocked(sql).mock.calls[0];
    // The tagged template strings array plus the interpolated values
    // companyId is the first interpolated value
    expect(callArgs).toBeDefined();
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(COMPANY_ID);
  });

  it('returns empty array when no directives found', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    const result = await listTaxDirectives(COMPANY_ID);

    expect(result).toEqual([]);
  });

  it('filters by status when filter provided', async () => {
    vi.mocked(sql).mockResolvedValueOnce([sampleDirective]);

    const result = await listTaxDirectives(COMPANY_ID, { status: 'pending' });

    expect(result).toHaveLength(1);
    // Status-filtered path calls sql once
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('skips status filter when status is "all"', async () => {
    vi.mocked(sql).mockResolvedValueOnce([sampleDirective]);

    await listTaxDirectives(COMPANY_ID, { status: 'all' });

    // Should call the unfiltered branch — still one sql call
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('DB down'));

    await expect(listTaxDirectives(COMPANY_ID)).rejects.toThrow('DB down');
  });
});

// ── createTaxDirective ────────────────────────────────────────────────────────

describe('createTaxDirective', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('inserts and returns the new directive', async () => {
    vi.mocked(sql).mockResolvedValueOnce([sampleDirective]);

    const result = await createTaxDirective(COMPANY_ID, sampleInput, USER_ID);

    expect(result).toMatchObject({
      id: DIRECTIVE_ID,
      company_id: COMPANY_ID,
      employee_name: 'John Doe',
    });
  });

  it('calls sql once (single INSERT RETURNING)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([sampleDirective]);

    await createTaxDirective(COMPANY_ID, sampleInput, USER_ID);

    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });

  it('passes companyId and userId as interpolated arguments', async () => {
    vi.mocked(sql).mockResolvedValueOnce([sampleDirective]);

    await createTaxDirective(COMPANY_ID, sampleInput, USER_ID);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(COMPANY_ID);
    expect(interpolated).toContain(USER_ID);
  });

  it('rethrows on SQL error', async () => {
    vi.mocked(sql).mockRejectedValueOnce(new Error('constraint violation'));

    await expect(
      createTaxDirective(COMPANY_ID, sampleInput, USER_ID)
    ).rejects.toThrow('constraint violation');
  });
});

// ── updateTaxDirectiveStatus ──────────────────────────────────────────────────

describe('updateTaxDirectiveStatus', () => {
  beforeEach(() => vi.mocked(sql).mockReset());

  it('updates status and returns updated directive', async () => {
    const updated: TaxDirective = { ...sampleDirective, status: 'approved', approved_by: USER_ID };
    vi.mocked(sql).mockResolvedValueOnce([updated]);

    const result = await updateTaxDirectiveStatus(COMPANY_ID, DIRECTIVE_ID, 'approved', USER_ID);

    expect(result.status).toBe('approved');
    expect(result.approved_by).toBe(USER_ID);
  });

  it('throws for an invalid status value', async () => {
    await expect(
      updateTaxDirectiveStatus(COMPANY_ID, DIRECTIVE_ID, 'revoked', USER_ID)
    ).rejects.toThrow('Invalid status: revoked');
  });

  it('throws when directive not found (empty result)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([]);

    await expect(
      updateTaxDirectiveStatus(COMPANY_ID, DIRECTIVE_ID, 'cancelled', USER_ID)
    ).rejects.toThrow('not found');
  });

  it('scopes the UPDATE to both id and companyId', async () => {
    const updated = { ...sampleDirective, status: 'expired' as const };
    vi.mocked(sql).mockResolvedValueOnce([updated]);

    await updateTaxDirectiveStatus(COMPANY_ID, DIRECTIVE_ID, 'expired', USER_ID);

    const callArgs = vi.mocked(sql).mock.calls[0];
    const interpolated = Array.from(callArgs ?? []).slice(1);
    expect(interpolated).toContain(COMPANY_ID);
    expect(interpolated).toContain(DIRECTIVE_ID);
  });

  it('accepts all valid statuses without throwing', async () => {
    const statuses = ['pending', 'approved', 'expired', 'cancelled'] as const;
    for (const status of statuses) {
      vi.mocked(sql).mockResolvedValueOnce([{ ...sampleDirective, status }]);
      const result = await updateTaxDirectiveStatus(COMPANY_ID, DIRECTIVE_ID, status, USER_ID);
      expect(result.status).toBe(status);
    }
  });
});
