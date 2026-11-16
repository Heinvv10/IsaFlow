/**
 * WP2 #1474 round 3: history VAT codes are trimmed + lowercased before validation, and a supplier whose history held
 * only invalid (non-null) codes is skipped by postProvisional instead of posting silently at 'none'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, predictMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), predictMock: vi.fn() }));

vi.mock('@/lib/neon', () => ({ sql: sqlMock, fmtDate: (x: unknown) => String(x) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({ createJournalEntry: vi.fn(), postJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankLineJournalGate', () => ({ handKeyedLineJournalRefusal: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/bank/bankLineImporterGate', () => ({
  importerAllocationRefusal: vi.fn(async () => null), importerArmOf: vi.fn(() => 'manual_journal'),
}));

import { predictFromHistory } from '@/modules/accounting/services/capture/provisionalPrediction';

function history(codes: Array<string | null>) {
  return codes.map((c) => ({ gl_account_id: 'gl-1', vat_code: c, cost_centre_id: null, project_id: null }));
}
async function predict(codes: Array<string | null>) {
  sqlMock.mockReset();
  sqlMock.mockResolvedValueOnce([{ id: 's-1', name: 'Eskom Holdings' }]);
  sqlMock.mockResolvedValueOnce(history(codes));
  return predictFromHistory('c-1', { id: 't', description: 'ESKOM HOLDINGS', amount: -100 });
}

describe('predictFromHistory: VAT code normalisation and all-invalid flag', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['Standard', ' STANDARD ', 'standard'])('counts %j as standard', async (code) => {
    const p = await predict([code, code]);
    expect(p.vatCode).toBe('standard');
    expect(p.vatHistoryAllInvalid).toBe(false);
  });

  it('flags a history of only invalid codes', async () => {
    const p = await predict(['4240294944', 'S']);
    expect(p.vatCode).toBeNull();
    expect(p.vatHistoryAllInvalid).toBe(true);
  });

  it('does not flag NULL-only history', async () => {
    const p = await predict([null, null]);
    expect(p.vatCode).toBeNull();
    expect(p.vatHistoryAllInvalid).toBe(false);
  });
});

describe('postProvisional: all-invalid VAT history', () => {
  it('skips with the reason before any write', async () => {
    vi.resetModules();
    vi.doMock('@/modules/accounting/services/capture/provisionalPrediction', () => ({ predictFromHistory: predictMock }));
    const { postProvisional } = await import('@/modules/accounting/services/capture/provisionalPostingService');
    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{ id: 't', amount: -115, description: 'ESKOM', status: 'imported', feed_state: 'posted',
      bank_account_id: 'ba-1', transaction_date: '2026-04-10' }]);
    predictMock.mockResolvedValueOnce({ supplierId: 's', supplierName: 'Eskom', glAccountId: 'gl', vatCode: null,
      costCentreId: null, projectId: null, confidence: 0.9, basis: 'history:2-rows', vatHistoryAllInvalid: true });
    const r = await postProvisional('c-1', 't', 'u-1');
    expect(r).toMatchObject({ journalEntryId: null, skipped: "no valid VAT code in this supplier's history" });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
