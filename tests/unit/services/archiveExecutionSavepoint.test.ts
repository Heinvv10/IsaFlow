/**
 * executeArchive runs inside the caller's withAuth request transaction.
 * Audit P2 carry-over: the failure path used to UPDATE archive_runs from an
 * already-aborted transaction — the UPDATE itself threw ("current transaction
 * is aborted"), masking the original error, and the 'failed' run record never
 * persisted. The fix wraps the archive body in a savepoint so a failure can
 * be rolled back cleanly and the failure mark recorded on the healthy tx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const withSavepointMock = vi.fn(async (name: string, fn: () => Promise<unknown>) => fn());
vi.mock('@/lib/neon', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
  withSavepoint: (name: string, fn: () => Promise<unknown>) => withSavepointMock(name, fn),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const logAuditOrThrow = vi.fn(async () => undefined);
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({
  logAuditOrThrow: (...a: unknown[]) => logAuditOrThrow(...a),
}));

import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';

function queryText(call: unknown[]): string {
  return (call[0] as readonly string[]).join('?');
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join('?');
    if (q.includes('INSERT INTO archive_runs')) return [{ id: 'run-1' }];
    return [];
  });
});

describe('executeArchive savepoint behavior', () => {
  it('wraps the archive body in a savepoint on the request tx', async () => {
    const result = await executeArchive('co-1', '2020-01-01', 'user-1');
    expect(result.runId).toBe('run-1');
    expect(withSavepointMock.mock.calls.map((c) => c[0])).toContain('archive_body');
  });

  it('marks the run failed (inside its own savepoint) and rethrows the ORIGINAL error', async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('INSERT INTO archive_runs')) return [{ id: 'run-1' }];
      if (q.includes('archive_gl_journal_entries')) throw new Error('boom');
      return [];
    });

    await expect(executeArchive('co-1', '2020-01-01', 'user-1')).rejects.toThrow('boom');

    const failedUpdate = sqlMock.mock.calls.find(
      (c) => queryText(c).includes('UPDATE archive_runs') && queryText(c).includes("'failed'"),
    );
    expect(failedUpdate).toBeDefined();
    expect(withSavepointMock.mock.calls.map((c) => c[0])).toContain('archive_mark_failed');
  });

  it('does not mask the original error when the failure mark itself fails', async () => {
    sqlMock.mockImplementation(async (strings: readonly string[]) => {
      const q = strings.join('?');
      if (q.includes('INSERT INTO archive_runs')) return [{ id: 'run-1' }];
      if (q.includes('archive_gl_journal_entries')) throw new Error('boom');
      if (q.includes("'failed'")) throw new Error('mark failed too');
      return [];
    });

    await expect(executeArchive('co-1', '2020-01-01', 'user-1')).rejects.toThrow('boom');
  });
});
