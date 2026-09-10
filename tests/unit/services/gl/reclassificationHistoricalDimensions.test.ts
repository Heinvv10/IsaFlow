import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createJournalEntry: vi.fn(async () => ({
    id: 'journal-1', entryNumber: 'JE-1', fiscalPeriodId: 'period-1',
  })),
  postJournalEntry: vi.fn(),
  createReclassBatch: vi.fn(async () => 'batch-1'),
  recordReclassBatchLines: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: mocks.createJournalEntry,
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: mocks.postJournalEntry,
}));
vi.mock('@/modules/accounting/services/gl/reclassification/batchService', () => ({
  createReclassBatch: mocks.createReclassBatch,
  recordReclassBatchLines: mocks.recordReclassBatchLines,
}));

import { postReclassBatch } from '@/modules/accounting/services/gl/reclassification/post';

describe('reclassification historical dimensions', () => {
  it('creates copy-forward journals in historical-copy mode', async () => {
    await postReclassBatch('company-1', 'user-1', {
      tool: 'post_reclassification_batch',
      sourceAccountId: 'source-1',
      targetAccountId: 'target-1',
      postingDate: null,
      idempotencyKey: 'key-1',
      drafts: [{
        date: '2026-04-01',
        description: 'Reclassification',
        lines: [
          { glAccountId: 'source-1', debit: 0, credit: 10, buId: 'inactive-bu' },
          { glAccountId: 'target-1', debit: 10, credit: 0, buId: 'inactive-bu' },
        ],
        sourceLineIds: ['line-1'],
        totalDebit: 10,
        totalCredit: 10,
      }],
    });

    expect(mocks.createJournalEntry.mock.calls[0]![4]).toEqual({
      dimensionAssignmentMode: 'historical-copy',
    });
  });
});
