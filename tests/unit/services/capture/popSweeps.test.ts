/**
 * runPopSweeps (popSweeps.ts), the cron's entry after the mail scan: it never throws, one company's failure does
 * not stop the next, and without POP_ARCHIVE_* credentials no archive sweep (so no Graph request) runs at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  openCompanies: vi.fn(), sweepMatches: vi.fn(), unarchived: vi.fn(), sweepArchive: vi.fn(), warn: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/capture/pop/popMatchSweep', () => ({
  companiesWithOpenPops: m.openCompanies, sweepPopMatches: m.sweepMatches,
}));
vi.mock('@/modules/accounting/services/capture/pop/popArchiveSweep', () => ({
  companiesWithUnarchivedPops: m.unarchived, sweepPopArchive: m.sweepArchive,
}));

import { runPopSweeps } from '@/modules/accounting/services/capture/pop/popSweeps';

const CREDS = { POP_ARCHIVE_TENANT_ID: 't', POP_ARCHIVE_CLIENT_ID: 'c', POP_ARCHIVE_CLIENT_SECRET: 's' };
const matchSummary = { checked: 1, attached: 1, ambiguous: 0, notFound: 0, refused: 0, errors: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  m.openCompanies.mockResolvedValue(['c1', 'c2']);
  m.sweepMatches.mockResolvedValue(matchSummary);
  m.unarchived.mockResolvedValue(['c1', 'c2']);
  m.sweepArchive.mockResolvedValue({ archived: 1, tooLarge: 0, failed: 0 });
});

describe('runPopSweeps', () => {
  it('sweeps every company for both and adds up the results', async () => {
    const totals = await runPopSweeps({ env: CREDS });
    expect(m.sweepMatches.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
    expect(m.sweepArchive.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']);
    expect(totals).toEqual({ match: { ...matchSummary, checked: 2, attached: 2 }, archive: { archived: 2, tooLarge: 0, failed: 0 } });
  });

  it('runs no archive sweep without credentials, and warns once', async () => {
    const totals = await runPopSweeps({ env: { POP_ARCHIVE_TENANT_ID: 't', POP_ARCHIVE_CLIENT_ID: 'c' } });
    expect(m.sweepArchive).not.toHaveBeenCalled();
    expect(totals.archive).toEqual({ archived: 0, tooLarge: 0, failed: 0 });
    expect(m.warn.mock.calls.filter((c) => String(c[0]).includes('credentials are not set'))).toHaveLength(1);
  });

  it('keeps going past a failing company and never throws, whatever fails', async () => {
    m.sweepMatches.mockRejectedValueOnce(new Error('db down for c1'));
    m.sweepArchive.mockRejectedValueOnce(new Error('graph down for c1'));
    const totals = await runPopSweeps({ env: CREDS });
    expect(m.sweepMatches).toHaveBeenCalledTimes(2);
    expect(m.sweepArchive).toHaveBeenCalledTimes(2);
    expect(totals.match.errors).toBe(1);
    expect(totals.archive).toEqual({ archived: 1, tooLarge: 0, failed: 1 });

    m.openCompanies.mockRejectedValueOnce(new Error('no pool'));
    m.unarchived.mockRejectedValueOnce(new Error('no pool'));
    await expect(runPopSweeps({ env: CREDS })).resolves.toMatchObject({ match: { errors: 1 }, archive: { failed: 1 } });
  });
});
