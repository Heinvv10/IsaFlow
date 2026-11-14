/**
 * runPopSweeps (popSweeps.ts), the cron's entry after the mail scan: it never throws, one company's failure does
 * not stop the next, without POP_ARCHIVE_* credentials no archive sweep (so no Graph request) runs (one warn when a
 * target exists, silence when none does), and nothing starts after the request's deadline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  openCompanies: vi.fn(), sweepMatches: vi.fn(), unarchived: vi.fn(), sweepArchive: vi.fn(), anyTarget: vi.fn(), warn: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/capture/pop/popMatchSweep', () => ({
  companiesWithOpenPops: m.openCompanies, sweepPopMatches: m.sweepMatches,
  emptyMatchSummary: () => ({ checked: 0, attached: 0, ambiguous: 0, notFound: 0, refused: 0, moved: 0, errors: 0 }),
}));
vi.mock('@/modules/accounting/services/capture/pop/popArchiveSweep', () => ({
  companiesWithUnarchivedPops: m.unarchived, sweepPopArchive: m.sweepArchive, anyArchiveTarget: m.anyTarget,
  emptyArchiveSummary: () => ({ archived: 0, tooLarge: 0, failed: 0, stopped: 0 }),
}));

import { runPopSweeps } from '@/modules/accounting/services/capture/pop/popSweeps';

const CREDS = { POP_ARCHIVE_TENANT_ID: 't', POP_ARCHIVE_CLIENT_ID: 'c', POP_ARCHIVE_CLIENT_SECRET: 's' };
const matchSummary = { checked: 1, attached: 1, ambiguous: 0, notFound: 0, refused: 0, moved: 1, errors: 0 };
const later = () => Date.now() + 120_000;
const credsWarnings = () => m.warn.mock.calls.filter((c) => String(c[0]).includes('POP_ARCHIVE_* is not set'));

beforeEach(() => {
  vi.clearAllMocks();
  m.openCompanies.mockResolvedValue(['c1', 'c2']);
  m.sweepMatches.mockResolvedValue(matchSummary);
  m.unarchived.mockResolvedValue(['c1', 'c2']);
  m.sweepArchive.mockResolvedValue({ archived: 1, tooLarge: 0, failed: 0, stopped: 0 });
  m.anyTarget.mockResolvedValue(true);
});

describe('runPopSweeps', () => {
  it('sweeps every company for both, under the deadline, and adds up the results', async () => {
    const deadline = later();
    const totals = await runPopSweeps({ deadline, env: CREDS });
    expect(m.sweepMatches.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
    expect(m.sweepArchive.mock.calls.map((c) => [c[0], c[3]])).toEqual([['c1', deadline], ['c2', deadline]]);
    expect(m.sweepMatches.mock.calls[0]![2]).toBeLessThanOrEqual(deadline);
    expect(totals).toEqual({ match: { ...matchSummary, checked: 2, attached: 2, moved: 2 }, archive: { archived: 2, tooLarge: 0, failed: 0, stopped: 0 } });
  });

  it('starts nothing once the deadline has passed', async () => {
    await runPopSweeps({ deadline: Date.now() - 1, env: CREDS });
    expect(m.sweepMatches).not.toHaveBeenCalled();
    expect(m.sweepArchive).not.toHaveBeenCalled();
  });

  it('runs no archive sweep without credentials: one warn when a target exists, none when none does', async () => {
    const totals = await runPopSweeps({ deadline: later(), env: { POP_ARCHIVE_TENANT_ID: 't', POP_ARCHIVE_CLIENT_ID: 'c' } });
    expect(m.sweepArchive).not.toHaveBeenCalled();
    expect(totals.archive).toEqual({ archived: 0, tooLarge: 0, failed: 0, stopped: 0 });
    expect(credsWarnings()).toHaveLength(1);

    m.warn.mockClear();
    m.anyTarget.mockResolvedValue(false);
    await runPopSweeps({ deadline: later(), env: {} });
    expect(credsWarnings()).toHaveLength(0);
  });

  it('keeps going past a failing company and never throws, whatever fails', async () => {
    m.sweepMatches.mockRejectedValueOnce(new Error('db down for c1'));
    m.sweepArchive.mockRejectedValueOnce(new Error('graph down for c1'));
    const totals = await runPopSweeps({ deadline: later(), env: CREDS });
    expect(m.sweepMatches).toHaveBeenCalledTimes(2);
    expect(m.sweepArchive).toHaveBeenCalledTimes(2);
    expect(totals.match.errors).toBe(1);
    expect(totals.archive).toEqual({ archived: 1, tooLarge: 0, failed: 1, stopped: 0 });

    m.openCompanies.mockRejectedValueOnce(new Error('no pool'));
    m.unarchived.mockRejectedValueOnce(new Error('no pool'));
    await expect(runPopSweeps({ deadline: later(), env: CREDS })).resolves.toMatchObject({ match: { errors: 1 }, archive: { failed: 1 } });
  });
});
