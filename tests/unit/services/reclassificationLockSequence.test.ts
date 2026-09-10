/**
 * READ → LOCK → RE-READ. The order, which is the whole of the fix.
 *
 * A lock held only across the INSERT protects nothing: both batches would still
 * have DECIDED which lines to move from reads taken before either committed.
 * The lock is worth taking only because every row-state guard is then evaluated
 * on a SECOND read, after the peer's batch rows are visible.
 *
 * That ordering is invisible to the DB-gated tests — they observe the lock and
 * they observe the verdict, and both look identical whether the plan re-read or
 * not. So it is asserted here, on call order, which is the one instrument that
 * can see it. The semantics are covered by `reclassificationDb.test.ts` and the
 * contention by `reclassificationLineLock.test.ts`; this file only pins the
 * sequence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const m = vi.hoisted(() => ({
  calls: [] as string[],
  findReclassCandidates: vi.fn(),
  countReclassCandidates: vi.fn(),
  lockReclassLinesForUpdate: vi.fn(),
  computeReclassImpact: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/reclassification/candidates', async (orig) => {
  const actual = await orig<typeof import(
    '@/modules/accounting/services/gl/reclassification/candidates')>();
  return {
    ...actual,
    findReclassCandidates: m.findReclassCandidates,
    countReclassCandidates: m.countReclassCandidates,
  };
});
vi.mock('@/modules/accounting/services/gl/reclassification/lineLock', () => ({
  lockReclassLinesForUpdate: m.lockReclassLinesForUpdate,
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  getAccountById: vi.fn(async (_c: string, id: string) => ({
    id, accountCode: id === 'src' ? '49775627' : '5100', accountName: 'Fixture',
    // LEVEL 3 is the load-bearing field: the header guard (K-052) bites only at
    // level 1-2, so at 3 the guard asks no child query and takes no account
    // lock, and this file can stay a pure call-order test. Drop it to 2 and
    // every write-path case here fails on the lock's own missing-transaction
    // error. The type is asset only because that is the realistic shape; at
    // level 3 nothing in this file distinguishes it.
    accountType: 'asset', accountSubtype: null, isActive: true, level: 3,
  })),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: vi.fn(async () => 'open'),
}));
vi.mock('@/modules/accounting/services/reports/vatPeriodLockService', () => ({
  isVatPeriodLocked: vi.fn(async () => false),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn(async () => '2026-04-16T00:00:00.000Z'),
}));
vi.mock('@/modules/accounting/services/gl/reclassification/impact', () => ({
  computeReclassImpact: m.computeReclassImpact,
}));
vi.mock('@/modules/accounting/services/gl/reclassification/warnings', () => ({
  reclassWarnings: vi.fn(() => []),
  targetPriorSources: vi.fn(async () => 0),
}));

import {
  planReclassification,
  isRefusal,
} from '@/modules/accounting/services/gl/reclassification/plan';

const TODAY = new Date().toLocaleDateString('en-CA');

const CANDIDATE = {
  line_id: 'l1', journal_entry_id: 'e1', entry_number: 'JE-1', entry_date: '2026-04-15',
  debit: '100.00', credit: '0.00', description: null, project_id: null, cost_center_id: null,
  vat_type: null, bu_id: null, cc1_id: null, cc2_id: null,
  reversed: false, is_reversal_leg: false, period_status: 'open', has_period: true,
  already_reclassified: false, is_reclass_contra: false, vat_period_locked: false,
};

const INPUT = {
  companyId: 'co', sourceAccountId: 'src', targetAccountId: 'tgt',
  from: null, to: null, postingDate: null,
};

beforeEach(() => {
  m.calls.length = 0;
  m.findReclassCandidates.mockReset();
  m.countReclassCandidates.mockReset().mockResolvedValue(1);
  m.lockReclassLinesForUpdate.mockReset();
  m.findReclassCandidates.mockImplementation(async () => {
    m.calls.push('read');
    return [CANDIDATE];
  });
  m.lockReclassLinesForUpdate.mockImplementation(async (_c: string, ids: string[]) => {
    m.calls.push('lock');
    return ids;
  });
  // Echoes the window it was GIVEN. Asserting `plan.impact.window` against a
  // hardcoded mock would test the mock; the window is computed by plan.ts and
  // handed to this function, so that is where it has to be observed.
  m.computeReclassImpact.mockImplementation(async (input: { window: unknown }) => ({
    window: input.window, profitAndLossBefore: {}, profitAndLossAfter: {}, accounts: [],
  }));
});

describe('the write path reads, LOCKS, then reads again', () => {
  it('evaluates the guards on a read taken AFTER the lock', async () => {
    const plan = await planReclassification({ ...INPUT, lockCandidateLines: true });
    expect(isRefusal(plan)).toBe(false);
    // Not "lock, read": the first read is what learns the ids to lock. Not
    // "read, lock": that decides on state a peer may still be holding
    // uncommitted, which is the defect.
    expect(m.calls).toEqual(['read', 'lock', 'read']);
  });

  it('locks exactly the lines the first read returned', async () => {
    await planReclassification({ ...INPUT, lockCandidateLines: true });
    expect(m.lockReclassLinesForUpdate).toHaveBeenCalledWith('co', ['l1']);
  });

  it('dates an EMPTY plan today, never 1970 or 9999', async () => {
    // A brand-new tenant, or an account nobody has posted to. The window used to
    // fall back to 1970-01-01 / 9999-12-31, which made `as_at` on an empty
    // report a date in the year 9999 — a reporting date no reader could act on,
    // asserted by a report that had read nothing.
    m.findReclassCandidates.mockImplementation(async () => { m.calls.push('read'); return []; });
    m.countReclassCandidates.mockResolvedValue(0);
    const plan = await planReclassification({ ...INPUT, lockCandidateLines: false });
    if (isRefusal(plan)) throw new Error(plan.refused);
    expect(plan.impact.window).toEqual({ start: TODAY, end: TODAY });
  });

  it('uses the CALLER\'s bounds for an empty plan when it was given them', async () => {
    m.findReclassCandidates.mockImplementation(async () => { m.calls.push('read'); return []; });
    m.countReclassCandidates.mockResolvedValue(0);
    const plan = await planReclassification({
      ...INPUT, from: '2026-01-01', to: '2026-03-31', lockCandidateLines: false,
    });
    if (isRefusal(plan)) throw new Error(plan.refused);
    expect(plan.impact.window).toEqual({ start: '2026-01-01', end: '2026-03-31' });
  });

  it('takes NO lock and reads ONCE on the preview path', async () => {
    const plan = await planReclassification({ ...INPUT, lockCandidateLines: false });
    expect(isRefusal(plan)).toBe(false);
    expect(m.calls).toEqual(['read']);
    expect(m.lockReclassLinesForUpdate).not.toHaveBeenCalled();
  });

  it('moves only what it locked — a line that appeared in the re-read is skipped', async () => {
    // The peer committed a new posting to the source account while this batch
    // waited. It is a real candidate and belongs in the universe, but it is not
    // locked, so moving it would reintroduce the race.
    m.lockReclassLinesForUpdate.mockImplementation(async () => {
      m.calls.push('lock');
      return ['l1'];
    });
    let read = 0;
    m.findReclassCandidates.mockImplementation(async () => {
      m.calls.push('read');
      read += 1;
      return read === 1
        ? [CANDIDATE]
        : [CANDIDATE, { ...CANDIDATE, line_id: 'l2', journal_entry_id: 'e2' }];
    });
    m.countReclassCandidates.mockResolvedValue(2);

    const plan = await planReclassification({ ...INPUT, lockCandidateLines: true });
    if (isRefusal(plan)) throw new Error(plan.refused);
    expect(plan.movable.map((c) => c.lineId)).toEqual(['l1']);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ lineId: 'l2', reason: 'appeared_after_lock' }),
    ]);
    // And the identity still holds, so no completeness fault fires with the
    // wrong stated cause.
    expect(plan.movable.length + plan.skipped.length).toBe(plan.universeTotal);
  });

  it('sees the peer\'s committed batch on the re-read and moves nothing', async () => {
    // The realistic outcome of losing the race: the first read said the line
    // was free, the peer committed while we waited on its row lock, and the
    // second read reports it as already moved.
    let read = 0;
    m.findReclassCandidates.mockImplementation(async () => {
      m.calls.push('read');
      read += 1;
      return read === 1
        ? [CANDIDATE]
        : [{ ...CANDIDATE, already_reclassified: true }];
    });

    const plan = await planReclassification({ ...INPUT, lockCandidateLines: true });
    if (isRefusal(plan)) throw new Error(plan.refused);
    expect(plan.movable).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({ reason: 'already_reclassified' });
  });
});
