// The preview screens a page row by row; once it has the postable lines it needs it stops paying for the rest (WP6 round 4, L2).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveRuleVatCode = vi.fn();
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({ resolveRuleVatCode: (...a: unknown[]) => resolveRuleVatCode(...a) }));
vi.mock('@/modules/accounting/services/gl/accountSubtypes', () => ({ isBankSubtype: () => false }));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({ getPeriodStatusForDate: async () => 'open' }));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', () => ({ findActiveVatLock: async () => null }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodAutoCreate', () => ({ isOutsideWindowByCalendarYear: () => false }));
vi.mock('@/modules/accounting/services/ap/bankLinePaymentGate', () => ({ isBankEvidenced: () => true }));
vi.mock('@/modules/accounting/services/bank/contactControlGuard', () => ({ contactControlAccountIds: async () => new Set<string>() }));
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', () => ({ importerAllocationRefusal: async () => null, importerArmOf: () => null }));
vi.mock('@/modules/accounting/services/bank/bankLineJournalGate', () => ({ handKeyedLineJournalRefusal: async () => null }));

import { screenCandidates } from '@/modules/accounting/services/bank/bankBulkAcceptEligibility';

const rows = Array.from({ length: 60 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, gl: 'gl-1', bank_account_id: 'bank-1', reconciliation_id: null,
  date: '2026-09-01', amount: -10, vat: null, account_subtype: null,
}));

describe('screenCandidates stopAt', () => {
  beforeEach(() => { resolveRuleVatCode.mockReset(); resolveRuleVatCode.mockResolvedValue({ denied: false, nonSupplyCoerced: false, vatCode: 'none' }); });

  it('screens no row past the one that reaches the limit, and names it', async () => {
    const out = await screenCandidates('c', 'u', rows as never, 26);
    expect(out.postable).toHaveLength(26);
    expect(resolveRuleVatCode).toHaveBeenCalledTimes(26);
    expect(out.stoppedAt).toBe(rows[25]!.id);
  });

  it('without a limit it screens every row', async () => {
    const out = await screenCandidates('c', 'u', rows as never);
    expect(out.postable).toHaveLength(60);
    expect(resolveRuleVatCode).toHaveBeenCalledTimes(60);
    expect(out.stoppedAt).toBeNull();
  });
});
