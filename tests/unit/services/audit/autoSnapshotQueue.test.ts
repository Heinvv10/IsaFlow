/**
 * The automatic snapshot never blocks a lock: queueing it only appends to the
 * request's after-commit list, never throws, and one request queues one run
 * with the latest cutoff per trigger.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const run = vi.fn();
vi.mock('@/modules/accounting/services/audit/autoSnapshot', () => ({ runAutoSnapshots: run }));

import { als, type RequestContext } from '@/lib/als';
import { drainAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { scheduleAutoSnapshot } from '@/modules/accounting/services/audit/autoSnapshotQueue';

const ctx = (extra: Partial<RequestContext> = {}) =>
  ({ client: {}, userId: 'u1', companyId: 'c1', claims: { sub: 'u1', session_id: 's' }, afterCommit: [], ...extra }) as unknown as RequestContext;

describe('scheduleAutoSnapshot', () => {
  it('queues ONE after-commit run per request, every cutoff per trigger, as the request principal', async () => {
    const c = ctx();
    als.run(c, () => {
      scheduleAutoSnapshot('period_close', '2026-01-31');
      scheduleAutoSnapshot('period_close', '2026-03-31');
      scheduleAutoSnapshot('period_close', '2026-02-28');
      scheduleAutoSnapshot('vat_lock', '2026-02-28');
    });
    expect(c.afterCommit).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    drainAfterCommit(c);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // Every cutoff is kept (the run snapshots the latest whose lock still stands), once per trigger.
    expect(run).toHaveBeenCalledWith({ userId: 'u1', companyId: 'c1', claims: { sub: 'u1', session_id: 's' } }, [
      { trigger: 'period_close', cutoffs: ['2026-01-31', '2026-03-31', '2026-02-28'] },
      { trigger: 'vat_lock', cutoffs: ['2026-02-28'] }]);
  });

  it('never throws: no request, a finished request, a request that runs no after-commit work', () => {
    expect(() => scheduleAutoSnapshot('year_close', '2026-12-31')).not.toThrow();
    expect(() => als.run(ctx({ finished: true }), () => scheduleAutoSnapshot('year_close', '2026-12-31'))).not.toThrow();
    expect(() => als.run(ctx({ afterCommit: undefined }), () => scheduleAutoSnapshot('year_close', '2026-12-31'))).not.toThrow();
    expect(vi.mocked(log.error)).toHaveBeenCalledWith('audit: could not queue the automatic snapshot', expect.anything(), 'audit');
  });
});
