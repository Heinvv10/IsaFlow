// RED phase — written before implementation
/**
 * Unit tests for alertResolutionService.ts — PRD-05 Phase 6
 *
 * Covers: resolvePendingAlertForInvoice — ±14 day window match, boundary
 * cases (exactly 14d, just outside at 15d), and no-pending-alert guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock ──────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  resolvePendingAlertForInvoice,
} from '@/modules/accounting/services/capture/alertResolutionService';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const SUPPLIER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const INVOICE_ID  = 'ff000000-0000-0000-0000-000000000005';
const ALERT_ID    = 'cc000000-0000-0000-0000-000000000003';

function makeAlertRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ALERT_ID,
    company_id: COMPANY_ID,
    supplier_id: SUPPLIER_ID,
    expected_by: '2026-04-15',
    status: 'pending',
    ...overrides,
  };
}

// ── resolvePendingAlertForInvoice ─────────────────────────────────────────────

describe('resolvePendingAlertForInvoice', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resolves alert when invoiceDate is 7 days before expected_by', async () => {
    // expected_by = 2026-04-15, invoiceDate = 2026-04-08 → within ±14d window.
    // Implementation uses a single UPDATE ... RETURNING — one sql call.
    vi.mocked(sqlMock).mockResolvedValueOnce([makeAlertRow({ expected_by: '2026-04-15' })] as never);

    const result = await resolvePendingAlertForInvoice(
      COMPANY_ID, SUPPLIER_ID, INVOICE_ID, '2026-04-08',
    );

    expect(result.resolvedAlertId).toBe(ALERT_ID);
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('resolves alert when invoiceDate is exactly 14 days after expected_by (boundary)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeAlertRow({ expected_by: '2026-04-01' })] as never);

    const result = await resolvePendingAlertForInvoice(
      COMPANY_ID, SUPPLIER_ID, INVOICE_ID, '2026-04-15',
    );

    expect(result.resolvedAlertId).toBe(ALERT_ID);
  });

  it('does not resolve when invoiceDate is 15 days outside expected_by window', async () => {
    // UPDATE ... RETURNING matches 0 rows → empty array → null.
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await resolvePendingAlertForInvoice(
      COMPANY_ID, SUPPLIER_ID, INVOICE_ID, '2026-04-16',
    );

    expect(result.resolvedAlertId).toBeNull();
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('returns {resolvedAlertId: null} when no pending alert exists for the supplier', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await resolvePendingAlertForInvoice(
      COMPANY_ID, SUPPLIER_ID, INVOICE_ID, '2026-04-15',
    );

    expect(result.resolvedAlertId).toBeNull();
  });

  it('issues exactly 1 SQL call when no alert is found (no spurious UPDATE)', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    await resolvePendingAlertForInvoice(
      COMPANY_ID, SUPPLIER_ID, INVOICE_ID, '2026-04-15',
    );

    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });
});
