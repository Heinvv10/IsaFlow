/**
 * vatGateOverrideService — the blocking-exceptions gate shared by locking a
 * VAT period and manually marking a VAT201 submission as submitted. Clean
 * periods pass untouched; blocking exceptions refuse unless an owner/admin
 * supplies a reason, which is then recorded (never a silent bypass).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const m = vi.hoisted(() => ({ sql: vi.fn(), getVatExceptions: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({
  getVatExceptions: m.getVatExceptions,
}));

import {
  assertVatGateClear, VatGateBlockedError, VatGateOverrideForbiddenError,
} from '@/modules/accounting/services/reports/vatGateOverrideService';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

function report(totalExceptions: number) {
  return {
    uncodedGlLineCount: 0, invoiceTaxCodeIssueCount: 0, invoiceGlMismatchCount: 0,
    vatOnBalanceSheetCount: 0, vatNonSupplyCount: 0, unpostedInvoiceVatCount: totalExceptions,
    unsupportedInputVatCount: 0, totalExceptions,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockResolvedValue([]);
});

describe('a clean period', () => {
  it('passes with no override and writes nothing', async () => {
    m.getVatExceptions.mockResolvedValue(report(0));
    const result = await assertVatGateClear(
      COMPANY, '2026-03-01', '2026-04-30', 'vat_period_lock', null, { userId: USER, role: 'viewer' }, undefined,
    );
    expect(result).toEqual({ overridden: false, counts: report(0) });
    expect(m.sql).not.toHaveBeenCalled();
  });
});

describe('blocking exceptions present', () => {
  it('refuses with no override reason, writing nothing', async () => {
    m.getVatExceptions.mockResolvedValue(report(3));
    await expect(assertVatGateClear(
      COMPANY, '2026-03-01', '2026-04-30', 'vat_period_lock', null, { userId: USER, role: 'owner' }, undefined,
    )).rejects.toBeInstanceOf(VatGateBlockedError);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('refuses a blank/whitespace reason the same as none', async () => {
    m.getVatExceptions.mockResolvedValue(report(1));
    await expect(assertVatGateClear(
      COMPANY, '2026-03-01', '2026-04-30', 'vat_period_lock', null, { userId: USER, role: 'owner' }, '   ',
    )).rejects.toBeInstanceOf(VatGateBlockedError);
  });

  it('refuses a non-owner/admin override with 403-mapped error, before any write', async () => {
    m.getVatExceptions.mockResolvedValue(report(2));
    await expect(assertVatGateClear(
      COMPANY, '2026-03-01', '2026-04-30', 'vat_period_lock', null,
      { userId: USER, role: 'manager' }, 'I checked it manually',
    )).rejects.toBeInstanceOf(VatGateOverrideForbiddenError);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('allows %s with a reason, and records the override with the exception snapshot', async (role) => {
    m.getVatExceptions.mockResolvedValue(report(4));
    const result = await assertVatGateClear(
      COMPANY, '2026-03-01', '2026-04-30', 'sars_submission', 'sub-1',
      { userId: USER, role }, 'Historical import, VAT filed under the old system',
    );
    expect(result.overridden).toBe(true);
    expect(m.sql).toHaveBeenCalledTimes(1);
    const insertedSql = String(m.sql.mock.calls[0]![0].join(''));
    expect(insertedSql).toMatch(/INSERT INTO vat_gate_overrides/);
    const values = m.sql.mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY);
    expect(values).toContain('sars_submission');
    expect(values).toContain('sub-1');
    expect(values).toContain(USER);
    expect(values).toContain('Historical import, VAT filed under the old system');
    expect(values.some((v: unknown) => typeof v === 'string' && v.includes('"totalExceptions":4'))).toBe(true);
  });
});
