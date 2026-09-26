/**
 * lock_vat_period's blocking-VAT-exceptions gate. MCP carries no role on its
 * context, so the tool reads it fresh from company_users
 * (getCompanyRoleForUser) before deciding whether an override_reason is
 * honoured. dry_run must preview the counts WITHOUT recording an override
 * (assertVatGateClear writes; a dry run must not).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/reports/vatReconciliationService', () => ({ getVatReconciliation: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vat201ExportService', () => ({ exportVat201: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vat201ReportService', () => ({ getVat201Report: vi.fn() }));

const m = vi.hoisted(() => ({
  getVatPeriodLock: vi.fn(),
  lockVatPeriod: vi.fn(),
  computeVatLockFigures: vi.fn(),
  assertLockablePeriod: vi.fn(),
  assertVatGateClear: vi.fn(),
  getCompanyRoleForUser: vi.fn(),
  getVatExceptions: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({
  getVatPeriodLock: m.getVatPeriodLock,
  lockVatPeriod: m.lockVatPeriod,
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockFigures', () => ({
  computeVatLockFigures: m.computeVatLockFigures,
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockBounds', () => {
  class VatPeriodLockRefusal extends Error {}
  return { VatPeriodLockRefusal, assertLockablePeriod: m.assertLockablePeriod };
});
vi.mock('@/modules/accounting/services/reports/vatExceptionsService', () => ({
  getVatExceptions: m.getVatExceptions,
}));
vi.mock('@/modules/accounting/services/reports/vatGateOverrideService', () => {
  class VatGateBlockedError extends Error { counts: unknown; constructor(counts: unknown) { super('blocked'); this.counts = counts; } }
  class VatGateOverrideForbiddenError extends Error {}
  return {
    assertVatGateClear: m.assertVatGateClear,
    getCompanyRoleForUser: m.getCompanyRoleForUser,
    vatGateExceptionCounts: (r: { totalExceptions: number }) => ({ totalExceptions: r.totalExceptions }),
    VatGateBlockedError,
    VatGateOverrideForbiddenError,
  };
});

import { lockVatPeriodTool } from '@/lib/mcp/tools/vatReports';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const ctx: McpToolContext = { userId: USER, companyId: COMPANY, scopes: ['read:vat', 'write:post'], tokenJti: 'tok-1', oauthAppId: null };
const FIGURES = { outputTax: 150, inputTax: 45, netVat: 105, postedThrough: '2026-04-30T10:00:00.000Z' };
const REPORT = { rateCheck: { ties: true }, excludedRows: [] };
const args = { period_start: '2026-03-01', period_end: '2026-04-30', idempotency_key: 'key-1' };

function text(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.computeVatLockFigures.mockResolvedValue({ figures: FIGURES, report: REPORT });
  m.getVatPeriodLock.mockResolvedValue(null);
  m.assertLockablePeriod.mockResolvedValue(undefined);
  m.getVatExceptions.mockResolvedValue({ totalExceptions: 0 });
  m.getCompanyRoleForUser.mockResolvedValue('owner');
  m.assertVatGateClear.mockResolvedValue({ overridden: false, counts: { totalExceptions: 0 } });
  m.lockVatPeriod.mockResolvedValue({ lock: { id: 'lock-1' }, created: true });
});

describe('dry_run', () => {
  it('previews exceptionCounts and wouldRequireOverride WITHOUT calling assertVatGateClear', async () => {
    m.getVatExceptions.mockResolvedValue({ totalExceptions: 4 });
    const result = await lockVatPeriodTool.handler({ ...args, dry_run: true }, ctx);
    expect(text(result).wouldRequireOverride).toBe(true);
    expect(text(result).exceptionCounts).toEqual({ totalExceptions: 4 });
    expect(m.assertVatGateClear).not.toHaveBeenCalled();
    expect(m.lockVatPeriod).not.toHaveBeenCalled();
  });
});

describe('live call', () => {
  it('reads the role fresh from company_users and passes it with override_reason to the gate', async () => {
    m.getCompanyRoleForUser.mockResolvedValue('admin');
    await lockVatPeriodTool.handler({ ...args, override_reason: 'Filed manually' }, ctx);
    expect(m.getCompanyRoleForUser).toHaveBeenCalledWith(COMPANY, USER);
    expect(m.assertVatGateClear).toHaveBeenCalledWith(
      COMPANY, '2026-03-01', '2026-04-30', 'vat_period_lock', null,
      { userId: USER, role: 'admin' }, 'Filed manually',
    );
  });

  it('returns a toolError and never locks when the gate refuses (blocked)', async () => {
    const { VatGateBlockedError } = await import('@/modules/accounting/services/reports/vatGateOverrideService');
    m.assertVatGateClear.mockRejectedValue(new VatGateBlockedError({ totalExceptions: 2 }));
    const result = await lockVatPeriodTool.handler(args, ctx);
    expect(result.isError).toBe(true);
    expect(m.lockVatPeriod).not.toHaveBeenCalled();
  });

  it('returns a toolError and never locks when the override is from a non-owner/admin', async () => {
    const { VatGateOverrideForbiddenError } = await import('@/modules/accounting/services/reports/vatGateOverrideService');
    m.assertVatGateClear.mockRejectedValue(new VatGateOverrideForbiddenError());
    const result = await lockVatPeriodTool.handler({ ...args, override_reason: 'trust me' }, ctx);
    expect(result.isError).toBe(true);
    expect(m.lockVatPeriod).not.toHaveBeenCalled();
  });

  it('locks when the gate passes clean', async () => {
    const result = await lockVatPeriodTool.handler(args, ctx);
    expect(result.isError).toBeUndefined();
    expect(m.lockVatPeriod).toHaveBeenCalledTimes(1);
  });
});
