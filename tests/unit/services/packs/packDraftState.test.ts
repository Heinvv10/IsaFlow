/**
 * ONE READ OF DRAFT STATUS, for the cover, the footer and the metadata.
 *
 * The defect this module exists for was not the definition — `packDraftStatus`
 * already had it — but a SECOND derivation: `packs/[id]/pdf.ts` computed
 * `draft: periodStatus !== 'closed'` of its own, which is one of the two
 * reasons a pack is a draft. Brightsphere's period is closed and its
 * commentary is unapproved, so its cover said DRAFT and every sheet carried
 * the watermark while the footer said only `Confidential — for board use`.
 * The rows that decide `unapprovedCommentary` are the same rows page 4 prints,
 * so they come back together and cannot drift apart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listCommentary = vi.fn(async () => [] as unknown[]);
const getPeriodStatusForDate = vi.fn(async () => 'open' as string);
vi.mock('@/modules/accounting/services/commentary/commentaryService', () => ({
  listCommentary: (...a: unknown[]) => listCommentary(...(a as [])),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: (...a: unknown[]) => getPeriodStatusForDate(...(a as [])),
}));

import { readPackDraftState } from '@/modules/accounting/services/packs/pages/packDraftState';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const read = () => readPackDraftState(COMPANY, 'board', '2026-01-01', '2026-08-31');
const approved = [{ status: 'approved', approvedText: 'The board reviewed these figures.' }];

beforeEach(() => {
  vi.clearAllMocks();
  listCommentary.mockResolvedValue([]);
  getPeriodStatusForDate.mockResolvedValue('open');
});

describe('readPackDraftState', () => {
  it('is FINAL only when the period is closed AND commentary is approved', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');
    listCommentary.mockResolvedValue(approved);
    expect((await read()).reasons).toEqual([]);
  });

  it('is a DRAFT on a closed period nobody has signed off — Brightsphere', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');
    expect((await read()).reasons).toEqual(['unapprovedCommentary']);
  });

  it('is a DRAFT on an open period even once commentary is approved', async () => {
    listCommentary.mockResolvedValue(approved);
    expect((await read()).reasons).toEqual(['openPeriod']);
  });

  it('names both reasons when neither fact holds', async () => {
    getPeriodStatusForDate.mockResolvedValue('no_period');
    expect((await read()).reasons).toEqual(['noPeriod', 'unapprovedCommentary']);
  });

  it('returns the approved commentary the same rows decided the status on', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');
    listCommentary.mockResolvedValue([
      { status: 'draft', approvedText: null, draftText: 'Machine-written, unsigned.' },
      { status: 'approved', approvedText: 'Revenue grew on the Cape contract.' },
      { status: 'rejected', approvedText: 'Discarded sentence.' },
    ]);
    const state = await read();
    expect(state.commentary?.body).toBe('Revenue grew on the Cape contract.');
    expect(state.reasons).toEqual([]);
  });

  it('reads commentary filed under the pack type it was asked for', async () => {
    await readPackDraftState(COMPANY, 'management', '2026-01-01', '2026-08-31');
    expect(listCommentary).toHaveBeenCalledWith(COMPANY, {
      type: 'management', from: '2026-01-01', to: '2026-08-31',
    });
  });

  it('scopes both reads to the company it was given', async () => {
    await read();
    expect(listCommentary.mock.calls[0]![0]).toBe(COMPANY);
    expect(getPeriodStatusForDate.mock.calls[0]![0]).toBe(COMPANY);
  });
});
