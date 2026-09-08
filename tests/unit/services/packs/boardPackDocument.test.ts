/**
 * The board pack's one meeting with the database.
 *
 * Three things are held here, and none of them is "the pages come out".
 *
 * 1. TENANT SCOPE. Every read is company-scoped, and the company is the one
 *    the route was authenticated for. A pack assembled from another tenant's
 *    figures is the worst defect this surface can ship, and it would look
 *    entirely normal on the page.
 * 2. THE LEDGER VERSION (R-P46). `getLedgerPostedThrough` still returns the
 *    deprecated epoch sentinel when the window consumed no posted journal.
 *    Page 12 is the auditability page; printing 1970-01-01 there as this
 *    pack's audit anchor is worse than printing "unavailable", which is what
 *    a null renders.
 * 3. DRAFT vs FINAL, from the period's actual status rather than a guess.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { demoSet, brand, matters, trend } from './fixtures/boardPackInputs';

const getCompanyName = vi.fn(async () => 'ISAFlow Demo (Pty) Ltd');
const buildPackFigureSet = vi.fn(async () => demoSet);
const getPackTrend = vi.fn(async () => trend);
// `buildMatters` hands back the matters AND the aged debtors total page 11's
// receivables reconciliation is taken against — see `PackMattersRead`. The
// demo fixture's total is its own control-account balance, so the two agree
// and no reconciliation prints; a mock returning the bare array would make
// every one of these tests build a pack with `agedDebtorsTotal` undefined.
const mattersRead = { matters, agedDebtorsTotal: demoSet.current.accountsReceivable };
const buildMatters = vi.fn(async () => mattersRead);
const getBrandProfile = vi.fn(async () => null);
const listCommentary = vi.fn(async () => [] as unknown[]);
const getLedgerPostedThrough = vi.fn(async () => '2026-08-31T10:00:00.000Z');
const getPeriodStatusForDate = vi.fn(async () => 'open');
// The receivables decomposition page 11 prints. Mocked like every other read
// here so this file's tenant-scope assertion covers it: it is a DB read that
// takes a companyId, and the whole point of the test below is that no read
// escapes the authenticated company. Unmocked it also reaches the real
// service, which issues reads of its own and makes the call counts here
// count something other than what they say.
const reconcileSubledger = vi.fn(async () => ({
  controlAccountBalance: -329_700,
  reconcilingItems: [],
  unexplainedDifference: 0,
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/companyName', () => ({
  getCompanyName: (...a: unknown[]) => getCompanyName(...(a as [])),
}));
vi.mock('@/modules/accounting/services/packs/figures/packFigureSet', () => ({
  buildPackFigureSet: (...a: unknown[]) => buildPackFigureSet(...(a as [])),
}));
vi.mock('@/modules/accounting/services/packs/packTrendService', () => ({
  getPackTrend: (...a: unknown[]) => getPackTrend(...(a as [])),
}));
vi.mock('@/modules/accounting/services/reconciliation/subledgerReconciliationService', () => ({
  reconcileSubledger: (...a: unknown[]) => reconcileSubledger(...(a as [])),
}));
vi.mock('@/modules/accounting/services/packs/pages/packMatters', () => ({
  buildMatters: (...a: unknown[]) => buildMatters(...(a as [])),
}));
vi.mock('@/modules/accounting/services/afs/brandProfileService', () => ({
  getBrandProfile: (...a: unknown[]) => getBrandProfile(...(a as [])),
}));
vi.mock('@/modules/accounting/services/commentary/commentaryService', () => ({
  listCommentary: (...a: unknown[]) => listCommentary(...(a as [])),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: (...a: unknown[]) => getPeriodStatusForDate(...(a as [])),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  NO_LEDGER_READ: '1970-01-01T00:00:00.000Z',
  getLedgerPostedThrough: (...a: unknown[]) => getLedgerPostedThrough(...(a as [])),
}));

import {
  buildBoardPackDocument,
  formatPackPeriod,
} from '@/modules/accounting/services/packs/pages/boardPackDocument';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '99999999-9999-4999-8999-999999999999';

const request = (over: Partial<Parameters<typeof buildBoardPackDocument>[0]> = {}) => ({
  companyId: COMPANY,
  from: '2026-03-01',
  to: '2026-08-31',
  preparedBy: 'reporting-qa@isaflow.dev',
  generatedAt: '2026-09-07T06:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getCompanyName.mockResolvedValue('ISAFlow Demo (Pty) Ltd');
  buildPackFigureSet.mockResolvedValue(demoSet);
  getPackTrend.mockResolvedValue(trend);
  buildMatters.mockResolvedValue(mattersRead);
  getBrandProfile.mockResolvedValue(null);
  listCommentary.mockResolvedValue([]);
  getLedgerPostedThrough.mockResolvedValue('2026-08-31T10:00:00.000Z');
  getPeriodStatusForDate.mockResolvedValue('open');
  reconcileSubledger.mockResolvedValue({
    controlAccountBalance: -329_700, reconcilingItems: [], unexplainedDifference: 0,
  });
});

describe('buildBoardPackDocument tenant scope', () => {
  it('passes the authenticated company to every read, and no other', async () => {
    await buildBoardPackDocument(request());

    for (const read of [
      getCompanyName, buildPackFigureSet, getPackTrend, buildMatters, reconcileSubledger,
      getBrandProfile, listCommentary, getLedgerPostedThrough, getPeriodStatusForDate,
    ]) {
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]![0]).toBe(COMPANY);
    }
  });

  it('builds for the company it was given rather than a remembered one', async () => {
    await buildBoardPackDocument(request());
    vi.clearAllMocks();
    buildPackFigureSet.mockResolvedValue(demoSet);
    getPackTrend.mockResolvedValue(trend);
    buildMatters.mockResolvedValue(mattersRead);
    listCommentary.mockResolvedValue([]);
    getLedgerPostedThrough.mockResolvedValue('2026-08-31T10:00:00.000Z');
    getPeriodStatusForDate.mockResolvedValue('open');
    getCompanyName.mockResolvedValue('Other Co');
    getBrandProfile.mockResolvedValue(null);

    await buildBoardPackDocument(request({ companyId: OTHER_COMPANY }));

    for (const read of [getCompanyName, buildPackFigureSet, buildMatters, getLedgerPostedThrough]) {
      expect(read.mock.calls[0]![0]).toBe(OTHER_COMPANY);
    }
  });

  it('scopes the matters to the figure set\'s own window, not an invented one', async () => {
    await buildBoardPackDocument(request());

    expect(buildMatters).toHaveBeenCalledWith(COMPANY, demoSet.currentWindow);
  });
});

describe('the ledger version (R-P46)', () => {
  it('prints the real posted-through watermark on page 12', async () => {
    getLedgerPostedThrough.mockResolvedValue('2026-08-31T10:00:00.000Z');

    const doc = await buildBoardPackDocument(request());

    expect(doc.basisOfPreparation.ledgerVersion).toBe('31 August 2026 at 12:00 SAST');
    // Read over the window, not just up to it: a watermark for all of time
    // would not change when the period does.
    expect(getLedgerPostedThrough).toHaveBeenCalledWith(COMPANY, '2026-08-31', '2026-03-01');
  });

  it('states "unavailable" rather than the 1970 sentinel when nothing was posted', async () => {
    getLedgerPostedThrough.mockResolvedValue('1970-01-01T00:00:00.000Z');

    const doc = await buildBoardPackDocument(request());

    expect(doc.basisOfPreparation.ledgerVersion).toMatch(/unavailable/i);
    expect(doc.basisOfPreparation.ledgerVersion).not.toContain('1970');
  });
});

describe('draft, commentary and period', () => {
  it('marks the pack DRAFT while the period it ends in is still open', async () => {
    getPeriodStatusForDate.mockResolvedValue('open');
    expect((await buildBoardPackDocument(request())).draft).toBe(true);
  });

  it('marks the pack DRAFT when no fiscal period covers the date at all', async () => {
    getPeriodStatusForDate.mockResolvedValue('no_period');
    expect((await buildBoardPackDocument(request())).draft).toBe(true);
  });

  /**
   * A PACK HAS TO EARN "FINAL", AND A CLOSED LEDGER IS ONLY HALF OF IT.
   *
   * Brightsphere's cover printed "This pack is FINAL." and the demo pack's,
   * from the same command on the same day, printed DRAFT — because
   * Brightsphere's September fiscal period is closed. It also had no approved
   * commentary, an inverted colour language and three trend titles reading
   * "rose from – to –", and it told a board it was final. One boolean was
   * measuring whether the FIGURES could move and asserting that the PACK was
   * finished.
   */
  it('will not call a pack FINAL on a closed period nobody has signed off', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');
    listCommentary.mockResolvedValue([]);
    expect((await buildBoardPackDocument(request())).draft).toBe(true);
  });

  it('marks the pack FINAL once the period is closed AND commentary is approved', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');
    listCommentary.mockResolvedValue([
      { status: 'approved', approvedText: 'The board reviewed these figures.', draftText: null },
    ]);
    expect((await buildBoardPackDocument(request())).draft).toBe(false);
  });

  it('stays a DRAFT on an open period even with commentary approved', async () => {
    getPeriodStatusForDate.mockResolvedValue('open');
    listCommentary.mockResolvedValue([
      { status: 'approved', approvedText: 'The board reviewed these figures.', draftText: null },
    ]);
    expect((await buildBoardPackDocument(request())).draft).toBe(true);
  });

  it('prints only commentary a human approved, never a draft sentence', async () => {
    listCommentary.mockResolvedValue([
      { status: 'draft', approvedText: null, draftText: 'Machine-written, unsigned.' },
      { status: 'approved', approvedText: 'Revenue grew on the Cape contract.', draftText: 'x' },
      { status: 'rejected', approvedText: 'Discarded sentence.', draftText: 'y' },
    ]);

    const doc = await buildBoardPackDocument(request());
    const narrative = doc.pages[3]!.blocks.find((b) => b.kind === 'narrative');

    expect(narrative?.kind === 'narrative' && narrative.narrative.status).toBe('approved');
    expect(narrative?.kind === 'narrative' && narrative.narrative.body)
      .toBe('Revenue grew on the Cape contract.');
    expect(JSON.stringify(doc)).not.toContain('Machine-written');
    expect(JSON.stringify(doc)).not.toContain('Discarded sentence');
  });

  it('falls back to the pending placeholder when nothing is approved', async () => {
    listCommentary.mockResolvedValue([{ status: 'draft', approvedText: null, draftText: 'x' }]);

    const doc = await buildBoardPackDocument(request());
    // Located by SEARCH, not by index: with no approved commentary there is
    // no narrative page, and the placeholder rides on its neighbour (spec
    // §5.7 — a page carrying one sentence does not ship). It is still
    // printed, and still says exactly the same thing.
    const pendingPages = doc.pages.filter((pg) =>
      pg.blocks.some((b) => b.kind === 'narrative' && b.narrative.status === 'pending'));

    expect(pendingPages.length).toBeGreaterThan(0);
    for (const pg of pendingPages) {
      expect(pg.blocks.length, `page ${pg.number} carries only the placeholder`).toBeGreaterThan(1);
    }
  });

  it('formats the period from ISO parts, never through a Date on a UTC+2 host', () => {
    // `new Date('2026-03-01')` is 28 February in local time here; a pack that
    // printed that would state a period it does not cover.
    expect(formatPackPeriod('2026-03-01', '2026-08-31')).toBe('1 March 2026 to 31 August 2026');
  });
});
