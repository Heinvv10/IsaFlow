/**
 * THE PER-ROW CAP ON APPROVED COMMENTARY IS A MEASURED FIGURE, NOT A GUESS.
 *
 * A person can now write the sentence they approve. Page 4 joins every
 * approved row's text into one paragraph (`packDraftState.approvedCommentary`)
 * and a page that does not fit its sheet is REFUSED — `buildBoardPackPages`
 * throws `PackRefusal` and the company gets no board pack at all
 * (`packApprovedCommentary.test.ts` pins that behaviour for thirty paragraphs).
 * So an over-long edit would not truncate; it would take the whole pack down.
 *
 * MEASUREMENT (the real page builder, bisecting the body length until page 4
 * stopped fitting; sentence-like prose, 7 rows — three income-statement
 * drivers plus the four risk areas `assessRiskAreas` can emit, the most
 * `buildDraftSentences` produces):
 *   liveDemoShortPanelsInput (tightest, page 4 at 218.2mm already): 1435 chars
 *   liveDemoInput: 1925 · liveDemoRenderedInput: 2177 · long null-quantum
 *   matters: 1827.
 * 7 x 180 + 6 joining spaces = 1266, leaving ~12% on the tightest fixture.
 * 7 x 205 would be the edge; 7 x 300 refuses.
 *
 * KNOWN LIMIT: text of the widest glyphs only (`WWWW MMMM ...`) fits 770
 * chars on the tightest fixture, i.e. 110 per row. No per-row character cap
 * is safe against that and a useful one at once; prose is what a CFO writes.
 *
 * Mutation check: raise MAX_APPROVED_TEXT_CHARS to 300 and the first test
 * goes red with a PackRefusal on page 4.
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
import { MAX_APPROVED_TEXT_CHARS } from '@/modules/accounting/services/commentary/commentaryLimits';
import {
  liveDemoShortPanelsInput, liveDemoInput, liveDemoRenderedInput, manyLongNullQuantumMattersInput,
} from './fixtures/liveDemoBoardPack';

/** The most rows `buildDraftSentences` can emit for one pack. */
const MAX_ROWS = 7;

const SENTENCE = 'Revenue grew because the two largest contracts renewed and the Gauteng rollout '
  + 'reached full billing, while overheads were held flat against the prior period. ';

/** Prose of exactly `n` characters. */
const prose = (n: number): string => SENTENCE.repeat(Math.ceil(n / SENTENCE.length)).slice(0, n).trim();

const approvedRows = (n: number, chars: number): CommentaryRow[] => Array.from({ length: n }, (_, i) => ({
  id: `row-${i}`, sectionRef: i < 3 ? 'income_statement' : 'balance_sheet', rowRef: `r${i}`,
  draftText: 'machine draft', approvedText: prose(chars), status: 'approved' as const,
  approvedBy: 'u1', approvedAt: '2026-10-01T00:00:00.000Z', withdrawnBy: null, withdrawnAt: null,
}));

describe('page 4 with every row approved at the per-row cap', () => {
  for (const [name, input] of Object.entries({
    liveDemoShortPanelsInput, liveDemoInput, liveDemoRenderedInput, manyLongNullQuantumMattersInput,
  })) {
    it(`composes twelve sheets without refusing — ${name}`, async () => {
      listMock.mockResolvedValue(approvedRows(MAX_ROWS, MAX_APPROVED_TEXT_CHARS));
      const { commentary } = await readPackDraftState('c1', 'board', '2026-01-01', '2026-03-31');
      expect(commentary?.body?.length, 'the join did not carry every row').toBeGreaterThan(
        MAX_ROWS * (MAX_APPROVED_TEXT_CHARS - 5));
      const doc = buildBoardPackPages({ ...input, commentary });
      expect(doc.pages).toHaveLength(12);
      const page4 = doc.pages.find((p) => p.navLabel === 'Commentary and actions')!;
      expect(pageMm(page4)).toBeLessThanOrEqual(pageBoxMm(page4));
    });
  }
});
