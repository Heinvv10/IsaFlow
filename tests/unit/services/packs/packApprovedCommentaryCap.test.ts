/**
 * THE PACK-WIDE BUDGET ON APPROVED COMMENTARY IS A MEASURED FIGURE.
 *
 * A person can now write the sentence they approve. Page 4 joins every
 * approved row's text into one paragraph (`packDraftState.approvedCommentary`)
 * and a page that does not fit its sheet is REFUSED — `buildBoardPackPages`
 * throws `PackRefusal` and the company gets no board pack at all
 * (`packApprovedCommentary.test.ts` pins that for thirty paragraphs). An
 * over-long approval would not truncate; it would take the whole pack down.
 * What can overflow is the SUM of the rows, so the limit is on the sum.
 *
 * MEASUREMENT (real page builder, bisecting the joined length until page 4
 * stopped fitting; sentence-like prose):
 *   liveDemoShortPanelsInput (tightest, page 4 already 218.2mm): 1435 chars
 *   liveDemoInput 1925 · liveDemoRenderedInput 2177 · long null-quantum
 *   matters 1827.
 * MAX_APPROVED_PACK_CHARS = 1300 leaves ~9% on the tightest. 20% over the
 * budget (1560) refuses there.
 *
 * KNOWN LIMIT: text of only the widest glyphs (`WWWW MMMM ...`) fits 770 joined
 * chars on the tightest fixture, so a budget of 1300 does not protect against
 * it. No useful character budget does; prose is what a CFO writes, and the
 * failure is a named refusal, not a silent one.
 *
 * Mutation check: raise MAX_APPROVED_PACK_CHARS to 1560 and the fit test goes
 * red with a PackRefusal on page 4.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';

const listMock = vi.fn();
vi.mock('@/modules/accounting/services/commentary/commentaryService', () => ({
  listCommentary: (...a: unknown[]) => listMock(...a),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: async () => 'closed',
}));

import { readPackDraftState } from '@/modules/accounting/services/packs/pages/packDraftState';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { MAX_APPROVED_PACK_CHARS, packCharsUsed } from '@/modules/accounting/services/commentary/commentaryLimits';
import {
  liveDemoShortPanelsInput, liveDemoInput, liveDemoRenderedInput, manyLongNullQuantumMattersInput,
} from './fixtures/liveDemoBoardPack';

/** The most rows `buildDraftSentences` can emit for one pack. */
const MAX_ROWS = 7;

const SENTENCE = 'Revenue grew because the two largest contracts renewed and the Gauteng rollout '
  + 'reached full billing, while overheads were held flat against the prior period. ';
const prose = (n: number): string => SENTENCE.repeat(Math.ceil(n / SENTENCE.length)).slice(0, n).replace(/\s$/, '.');

/** `rows` approved rows whose budget cost (length + 1 each) sums to `total`. */
function approvedRows(rows: number, total: number): CommentaryRow[] {
  const lengths = Array.from({ length: rows }, (_, i) => Math.floor((total - rows) / rows) + (i < (total - rows) % rows ? 1 : 0));
  return lengths.map((n, i) => ({
    id: `row-${i}`, sectionRef: i < 3 ? 'income_statement' : 'balance_sheet', rowRef: `r${i}`,
    draftText: 'machine draft', approvedText: prose(n), status: 'approved' as const,
    approvedBy: 'u1', approvedAt: '2026-10-01T00:00:00.000Z', withdrawnBy: null, withdrawnAt: null,
  }));
}

const FIXTURES = {
  liveDemoShortPanelsInput, liveDemoInput, liveDemoRenderedInput, manyLongNullQuantumMattersInput,
};

async function compose(input: typeof liveDemoInput, rows: CommentaryRow[]) {
  listMock.mockResolvedValue(rows);
  const { commentary } = await readPackDraftState('c1', 'board', '2026-01-01', '2026-03-31');
  return buildBoardPackPages({ ...input, commentary });
}

describe('page 4 with the pack at its approved-commentary budget', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    for (const rows of [1, 4, MAX_ROWS]) {
      it(`composes twelve sheets — ${name}, ${rows} row(s) summing to the budget`, async () => {
        const approved = approvedRows(rows, MAX_APPROVED_PACK_CHARS);
        expect(packCharsUsed(approved), 'the rows are not at the budget').toBe(MAX_APPROVED_PACK_CHARS);
        const doc = await compose(input, approved);
        expect(doc.pages).toHaveLength(12);
        const page4 = doc.pages.find((p) => p.navLabel === 'Commentary and actions')!;
        expect(pageMm(page4)).toBeLessThanOrEqual(pageBoxMm(page4));
      });
    }
  }

  it('refuses at 20% over the budget on the tightest page, and says the commentary is too long', async () => {
    const over = approvedRows(MAX_ROWS, Math.round(MAX_APPROVED_PACK_CHARS * 1.2));
    let refusal: PackRefusal | null = null;
    try { await compose(liveDemoShortPanelsInput, over); } catch (e) {
      refusal = e instanceof PackRefusal ? e : null;
      if (refusal === null) throw e;
    }
    expect(refusal, 'budget +20% still composed: the budget has no margin to defend').not.toBeNull();
    // A person is told WHICH thing is too long and what to do — not "contact support".
    expect(refusal!.userMessage).toContain('approved commentary is too long for page 4');
    expect(refusal!.userMessage).not.toContain('contact support');
  });
});
