/**
 * `runJournalControl`'s poison site: what it marks, and what it records.
 *
 * Written because deleting `recordControlRefusal(error)` from that site killed no test. The wrapper
 * tests prove withAuth answers a RECORDED refusal with its own status and rolls back, and the
 * integration suite proves the whole chain end to end — but integration does not run in `bun run ci`
 * (it is gated on DATABASE_URL), so the one line joining the two halves had no CI guard at all. A
 * direct journal post would have gone back to 500 CONTROL_INTEGRITY_FAILED with every gate green.
 *
 * Both halves are asserted here, because they are separate promises with opposite failure modes:
 *
 *   - `controlWriteFailed` is what forces the ROLLBACK, and it must be set for EVERY error — the
 *     direct routes create their draft journal outside the controlled write, and withAuth COMMITs
 *     anything under 500, so a refusal that did not poison would strand the orphan draft.
 *   - `controlRefusal` is only what the client is TOLD. It is recorded for every error too, and the
 *     transport (`apiRefusal.ts`) decides which ones change the answer — so an integrity failure
 *     recorded here still reaches the client as 500.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { als, type RequestContext } from '@/lib/als';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';

const executeControlledOperation = vi.fn();
// Only requireControlTx is replaced. `recordControlRefusal` lives in @/lib/als, which is NOT mocked
// here, so the write onto the store under test is the real one rather than an assertion about a mock.
vi.mock('@/modules/accounting/services/controls/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/controls/context')>();
  return { ...actual, requireControlTx: () => fakeCtx };
});
vi.mock('@/modules/accounting/services/controls/approvalExecutionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/controls/approvalExecutionService')>();
  return { ...actual, executeControlledOperation };
});

/**
 * The two prechecks `runJournalControl` runs before the controlled write read the entry, the company
 * and its fiscal period, and BOTH return silently when those rows cannot be read cleanly — which an
 * empty result is. So an empty `sql` leaves the refusal below as the only thing that can throw.
 */
const fakeCtx = {
  sql: () => Promise.resolve([]),
  principal: { companyId: 'company-1', personId: 'person-1' },
} as unknown as ControlTx;

const ref: OperationRef = { operation: 'journal.post', entityType: 'journal_entry', entityId: 'journal-1' };

/** Run inside an ALS store the way withAuth does, and report what the poison site left on it. */
async function post(thrown: unknown): Promise<{ caught: unknown; store: RequestContext }> {
  const store = { client: {}, userId: 'person-1', companyId: 'company-1', claims: {} } as unknown as RequestContext;
  executeControlledOperation.mockRejectedValueOnce(thrown);
  const { runJournalControl } = await import('@/modules/accounting/services/gl/journalControlService');
  const caught = await als.run(store, async () => {
    try {
      await runJournalControl('company-1', 'person-1', ref, undefined, async () => 'posted');
      return 'RESOLVED — the refusal did not propagate';
    } catch (error) { return error; }
  });
  return { caught, store };
}

describe('runJournalControl poisons AND records what refused', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('records an approval-required refusal, so the wrapper can answer 409 instead of 500', async () => {
    const { OperationApprovalRequiredError } = await import('@/modules/accounting/services/controls/approvalExecutionService');
    const refusal = new OperationApprovalRequiredError();
    const { caught, store } = await post(refusal);
    expect(caught).toBe(refusal);
    // The half that forces the rollback — unchanged, and asserted so a future
    // "the refusal is not an integrity failure" cleanup cannot quietly drop it.
    expect(store.controlWriteFailed).toBe(true);
    // The half that decides what the caller is told.
    expect(store.controlRefusal).toBe(refusal);
  });

  it('still poisons an integrity failure, whose recorded cause the transport leaves at 500', async () => {
    const { typedRefusalCode } = await import('@/lib/apiRefusal');
    const failure = new Error('Change event could not be recorded');
    const { caught, store } = await post(failure);
    expect(caught).toBe(failure);
    expect(store.controlWriteFailed).toBe(true);
    expect(store.controlRefusal).toBe(failure);
    // Recorded, but not a registered refusal — so the answer stays a 500.
    expect(typedRefusalCode(store.controlRefusal)).toBeNull();
  });

  it('poisons a pg driver error too, and it is never mistaken for a refusal', async () => {
    const { typedRefusalCode } = await import('@/lib/apiRefusal');
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const { store } = await post(deadlock);
    expect(store.controlWriteFailed).toBe(true);
    expect(typedRefusalCode(store.controlRefusal)).toBeNull();
  });
});
