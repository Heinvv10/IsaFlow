// W8: a batch that a concurrent undo closed between the check and undoRun's own is the same typed refusal, not a bare Error.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/bank/autoPostUndoService', async () => {
  class RunAlreadyUndoneError extends Error {}
  return { undoRun: vi.fn(), RunAlreadyUndoneError };
});
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ allocateTransaction: vi.fn() }));

import { sql } from '@/lib/neon';
import { undoRun, RunAlreadyUndoneError } from '@/modules/accounting/services/bank/autoPostUndoService';
import { undoBulkAcceptBatch } from '@/modules/accounting/services/bank/bankBulkAcceptService';
import { isBulkAcceptRefusal } from '@/modules/accounting/services/bank/bankBulkAcceptPreview';

beforeEach(() => {
  vi.mocked(sql).mockReset();
  vi.mocked(sql).mockResolvedValue([{ source: 'manual', undone_at: null }] as never);
  vi.mocked(undoRun).mockReset();
});

describe('undoBulkAcceptBatch', () => {
  it('maps undoRun\'s "already undone" race to a typed 400 refusal', async () => {
    vi.mocked(undoRun).mockRejectedValue(new RunAlreadyUndoneError());
    const err = await undoBulkAcceptBatch('co', 'run', 'u').catch((e: unknown) => e);
    expect(isBulkAcceptRefusal(err)).toBe(true);
    expect((err as { status: number }).status).toBe(400);
  });

  it('any other failure of undoRun is not swallowed', async () => {
    vi.mocked(undoRun).mockRejectedValue(new TypeError('boom'));
    await expect(undoBulkAcceptBatch('co', 'run', 'u')).rejects.toThrow('boom');
  });
});
