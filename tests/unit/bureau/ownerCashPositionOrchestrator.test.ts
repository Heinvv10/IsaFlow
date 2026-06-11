// tests/unit/bureau/ownerCashPositionOrchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/debtorsManagerService', () => ({ getDebtorsSummary: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vatReturnService', () => ({ getVATReturn: vi.fn() }));

import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';
import { getDebtorsSummary } from '@/modules/accounting/services/ar/debtorsManagerService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import type { VATReturnReport } from '@/modules/accounting/types/gl.types';
import { log } from '@/lib/logger';

const vatReturn = (netVAT: number): VATReturnReport =>
  ({ netVAT } as Partial<VATReturnReport> as VATReturnReport);

const COMPANY = '11111111-1111-1111-1111-111111111111';
const TODAY = new Date('2026-06-11T08:00:00Z');

function mockSqlByQuery(handlers: Record<string, unknown[]>) {
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join('?');
    for (const [needle, rows] of Object.entries(handlers)) {
      if (q.includes(needle)) return rows;
    }
    return [];
  });
}

describe('getOwnerCashPosition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('assembles all three sections', async () => {
    mockSqlByQuery({
      payroll_run_headers: [{
        id: 'run-1', period_month: 6, period_year: 2026, status: 'approved',
        total_net: '90000', total_paye: '14000', total_uif: '1800', total_sdl: '1000', total_eti: '800',
      }],
      'FROM companies': [{ vat_period_alignment: 'odd', vat_period: 'bi-monthly' }],
    });
    vi.mocked(getDebtorsSummary).mockResolvedValue([
      { clientId: 'c1', clientName: 'Acme', current: 0, days30: 5000, days60: 0, days90: 0, days90Plus: 0, totalOutstanding: 50000, invoiceCount: 2 },
    ]);
    vi.mocked(getVATReturn).mockResolvedValue(vatReturn(23000));

    const pos = await getOwnerCashPosition(COMPANY, 150000, TODAY);
    expect(pos.cash).toBe(150000);
    expect(pos.payroll?.canPay).toBe(true);
    expect(pos.payroll?.totalRequired).toBe(106000);
    expect(pos.topDebtors[0]?.clientName).toBe('Acme');
    expect(pos.arTotal).toBe(50000);
    expect(pos.vat?.netVat).toBe(23000);
    // VAT period for 'odd' alignment on 2026-06-11 (bi-monthly) — Apr–May 2026, due 25 Jun
    expect(pos.vat?.dueDate).toBe('2026-06-25');
  });

  it('returns null payroll when no unpaid run exists', async () => {
    mockSqlByQuery({ 'FROM companies': [{ vat_period_alignment: 'odd', vat_period: 'bi-monthly' }] });
    vi.mocked(getDebtorsSummary).mockResolvedValue([]);
    vi.mocked(getVATReturn).mockResolvedValue(vatReturn(0));
    const pos = await getOwnerCashPosition(COMPANY, 1000, TODAY);
    expect(pos.payroll).toBeNull();
    expect(pos.topDebtors).toEqual([]);
  });

  it('fails soft per section: VAT error → vat null + warn, other sections intact', async () => {
    mockSqlByQuery({
      payroll_run_headers: [{
        id: 'run-1', period_month: 6, period_year: 2026, status: 'draft',
        total_net: '100', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0',
      }],
      'FROM companies': [{ vat_period_alignment: 'odd', vat_period: 'bi-monthly' }],
    });
    vi.mocked(getDebtorsSummary).mockResolvedValue([]);
    vi.mocked(getVATReturn).mockRejectedValue(new Error('boom'));
    const pos = await getOwnerCashPosition(COMPANY, 1000, TODAY);
    expect(pos.vat).toBeNull();
    expect(pos.payroll?.status).toBe('estimated');
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it('returns null vat when company row is missing', async () => {
    mockSqlByQuery({ payroll_run_headers: [], 'FROM companies': [] });
    vi.mocked(getDebtorsSummary).mockResolvedValue([]);
    const pos = await getOwnerCashPosition(COMPANY, 0, TODAY);
    expect(pos.vat).toBeNull();
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it('fails soft when debtors summary throws', async () => {
    mockSqlByQuery({ 'FROM companies': [{ vat_period_alignment: 'odd', vat_period: 'bi-monthly' }] });
    vi.mocked(getDebtorsSummary).mockRejectedValue(new Error('boom'));
    vi.mocked(getVATReturn).mockResolvedValue(vatReturn(0));
    const pos = await getOwnerCashPosition(COMPANY, 1000, TODAY);
    expect(pos.topDebtors).toEqual([]);
    expect(pos.arTotal).toBe(0);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });

  it('fails soft when the payroll query throws', async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('payroll_run_headers')) throw new Error('boom');
      if (q.includes('FROM companies')) return [{ vat_period_alignment: 'odd', vat_period: 'bi-monthly' }];
      return [];
    });
    vi.mocked(getDebtorsSummary).mockResolvedValue([]);
    vi.mocked(getVATReturn).mockResolvedValue(vatReturn(0));
    const pos = await getOwnerCashPosition(COMPANY, 1000, TODAY);
    expect(pos.payroll).toBeNull();
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});
