/**
 * WP2 row 13, the unattended poster: postProvisional skips a predicted VAT code outside none / standard /
 * zero_rated / exempt before any write. The predictor now returns only valid codes (provisionalPrediction), so the
 * predictor is mocked here to reach the guard that stands behind it.
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
vi.mock('@/modules/accounting/services/capture/provisionalPrediction', () => ({ predictFromHistory: predictMock }));

import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';

const TX = '00000000-0000-4000-8000-0000000000aa';

describe('postProvisional: an unknown predicted VAT code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlMock.mockResolvedValueOnce([{ id: TX, amount: -115, description: 'ESKOM', status: 'imported', feed_state: 'posted',
      bank_account_id: 'ba-1', transaction_date: '2026-04-10' }]);
  });

  it.each(['4240294944', 'S', 'STANDARD'])('skips %j before any write', async (code) => {
    predictMock.mockResolvedValueOnce({ supplierId: 's', supplierName: 'Eskom', glAccountId: 'gl', vatCode: code,
      costCentreId: null, projectId: null, confidence: 0.9, basis: 'history:4-rows' });
    const result = await postProvisional('c-1', TX, 'u-1');
    expect(result).toMatchObject({ journalEntryId: null, skipped: `unknown VAT code "${code}"` });
    expect(createJournalEntry).not.toHaveBeenCalled();
    expect(sqlMock).toHaveBeenCalledTimes(1); // the line read only: no write
  });
});
