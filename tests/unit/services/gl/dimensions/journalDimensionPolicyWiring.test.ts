/**
 * Dimensions Phase 1 — createJournalEntry runs the dimension policy on every
 * NEW journal (settlements refused, CC1 derived from CC2) BEFORE it inserts,
 * and writes the derived values; reversals and reclassifications
 * ('historical-copy') copy history and skip it.
 *
 * Pinned at the call site because the policy module having its own tests
 * proves nothing about whether the write boundary calls it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, transaction } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  transaction: vi.fn(async () => [[{ id: 'je-1', entry_number: 'JE-1', company_id: 'c', entry_date: '2026-09-30', status: 'draft', source: 'manual' }]]),
}));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign((...a: unknown[]) => sqlMock(...a), { transaction }),
  withTransaction: vi.fn(),
  fmtDate: (v: unknown) => String(v ?? ''),
}));
vi.mock('@/lib/alsTransaction', () => ({ withAlsTransaction: (_a: unknown, fn: () => unknown) => fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodAutoCreate', () => ({ ensureFiscalPeriodForDate: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/gl/lateClaimClearingGuard', () => ({ assertNoLateClaimClearingLines: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalLineOwnership', () => ({ assertJournalLinesOwned: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/journalVatLockGuard')>()),
  assertJournalVatPeriodOpen: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionPolicy', () => ({ applyJournalDimensionPolicy: vi.fn() }));

import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { applyJournalDimensionPolicy } from '@/modules/accounting/services/gl/dimensions/dimensionPolicy';
import { DimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const USER = 'ffffffff-0000-4000-8000-ffffffffffff';
const INPUT = {
  entryDate: '2026-09-30', description: 't', source: 'manual' as const,
  lines: [
    { glAccountId: 'cos', debit: 100, credit: 0, cc2Id: 'lawley' },
    { glAccountId: 'bank', debit: 0, credit: 100 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([]);
});

describe('createJournalEntry — dimension policy wiring', () => {
  it('writes the DERIVED dimensions the policy returns', async () => {
    vi.mocked(applyJournalDimensionPolicy).mockImplementation(async (_c, _s, lines) =>
      lines.map((l) => (l.cc2Id ? { ...l, cc1Id: 'fno-ft' } : l)));
    await createJournalEntry(COMPANY, INPUT, USER).catch(() => undefined);
    expect(applyJournalDimensionPolicy).toHaveBeenCalledWith(COMPANY, 'manual', INPUT.lines);
    const lineInsert = sqlMock.mock.calls.find((c) => (c[0] as string[]).join('').includes('INSERT INTO gl_journal_lines')
      && c.includes('cos'));
    expect(lineInsert).toBeDefined();
    expect(lineInsert).toContain('fno-ft');
    expect(lineInsert).toContain('lawley');
  });

  it('a refused policy (dimensions on a settlement) inserts NOTHING', async () => {
    vi.mocked(applyJournalDimensionPolicy).mockRejectedValueOnce(new DimensionRefusal('A settlement ... carries no CC1/CC2/BU'));
    await expect(createJournalEntry(COMPANY, { ...INPUT, source: 'auto_supplier_payment' }, USER))
      .rejects.toThrow(/carries no CC1\/CC2\/BU/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('historical-copy (reversal / reclassification) does not re-run the policy', async () => {
    await createJournalEntry(COMPANY, INPUT, USER, undefined, { dimensionAssignmentMode: 'historical-copy' })
      .catch(() => undefined);
    expect(applyJournalDimensionPolicy).not.toHaveBeenCalled();
  });
});
