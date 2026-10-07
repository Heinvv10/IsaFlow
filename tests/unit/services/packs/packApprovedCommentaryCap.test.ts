/**
 * THE PACK-WIDE BUDGET ON APPROVED COMMENTARY IS MEASURED IN THE PAGE'S OWN UNITS.
 *
 * A person can now write the sentence they approve. Page 4 joins every
 * approved row's text into one paragraph (`packDraftState.approvedCommentary`)
 * and a page that does not fit its sheet is REFUSED — `buildBoardPackPages`
 * throws `PackRefusal` and the company gets no board pack at all. What can
 * overflow is the SUM of the rows, so the limit is on the sum, costed with
 * `commentaryEms`: the page's em ruler, with each word charged by the lines it
 * takes the way `wrapEms` sets it (a word a line cannot share wastes the rest
 * of its line). A character count let all-caps or CJK text take twice the room
 * of prose, and a plain ems sum let a text of line-wide words pass the editor
 * and be refused by the page.
 *
 * MEASUREMENT (real page builder; the cost of the joined text page 4 holds
 * before it refuses, tightest fixture `liveDemoShortPanelsInput`): wide glyphs
 * 619, digits 620, prose/caps/long words 639, URL in prose 724, CJK 799, and
 * uniform words of 10..70 characters 620 to 1178. Other fixtures hold up to
 * 1766. MAX_APPROVED_PACK_EMS = 560 sits 9% under the lowest, so EVERY kind at
 * the budget fits EVERY fixture, including the N = 10..70 sweep of uniform
 * words; 3.5x the budget refuses on every fixture for every kind, and 1.3x
 * refuses on the tightest for the kinds whose capacity is nearest the budget.
 *
 * Mutation check: raise MAX_APPROVED_PACK_EMS to 1750 and the at-budget tests
 * go red with a PackRefusal on page 4.
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
import { fitBodyPage } from '@/modules/accounting/services/packs/pages/packNarrativeFit';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import {
  MAX_APPROVED_PACK_EMS, commentaryEms, packEmsUsed,
} from '@/modules/accounting/services/commentary/commentaryLimits';
import {
  liveDemoShortPanelsInput, liveDemoInput, liveDemoRenderedInput, manyLongNullQuantumMattersInput,
} from './fixtures/liveDemoBoardPack';

/** The most rows `buildDraftSentences` can emit for one pack. */
const MAX_ROWS = 7;

const KINDS: Record<string, string> = {
  prose: 'Revenue grew because the two largest contracts renewed and the Gauteng rollout reached full billing, while overheads were held flat against the prior period. ',
  caps: 'REVENUE GREW BECAUSE THE TWO LARGEST CONTRACTS RENEWED AND THE GAUTENG ROLLOUT REACHED FULL BILLING. ',
  wide: 'WWWWWWWW MMMMMMMM WWWWWWWW MMMMMMMM ',
  digits: '1234567 8901234 5678901 2345678 ',
  longwords: 'Internationalisation notwithstanding, counterparties renegotiated unprecedented arrangements ',
  url: 'Revenue grew; the supplier schedule is at https://x.co/?id=0a1b2c3d4e0a1b2c3d4e0a1b2c3d4e0a1b2c3d4e for detail. ',
  cjk: '收入增长是因为两个最大的合同续签并且豪登省的推广达到了全面计费。 ',
};
// Uniform words of N characters, N = 10..70: the line-wide cases a plain ems sum missed.
for (let n = 10; n <= 70; n += 4) KINDS[`words of ${n}`] = `${'a'.repeat(n)} `;

/** The longest text of `kind` whose cost is at most `ems`. */
function textCosting(kind: string, ems: number): string {
  const pattern = KINDS[kind]!;
  let out = '';
  for (let i = 0; ; i++) {
    const next = out + pattern[i % pattern.length]!;
    if (commentaryEms(next) > ems) return out.trim();
    out = next;
  }
}

/** `rows` approved rows of `kind` that together cost `factor` x the budget. */
function approvedRows(kind: string, rows: number, factor: number): CommentaryRow[] {
  return Array.from({ length: rows }, (_, i) => ({
    id: `row-${i}`, sectionRef: i < 3 ? 'income_statement' : 'balance_sheet', rowRef: `r${i}`,
    draftText: 'machine draft', approvedText: textCosting(kind, (MAX_APPROVED_PACK_EMS * factor) / rows),
    status: 'approved' as const, approvedBy: 'u1', approvedAt: '2026-10-01T00:00:00.000Z',
    withdrawnBy: null, withdrawnAt: null,
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

async function refusalOf(input: typeof liveDemoInput, rows: CommentaryRow[]): Promise<PackRefusal | null> {
  try { await compose(input, rows); } catch (e) {
    if (e instanceof PackRefusal) return e;
    throw e;
  }
  return null;
}

describe('the pack at its approved-commentary budget, whatever the text is made of', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    for (const kind of Object.keys(KINDS)) {
      for (const rows of [1, MAX_ROWS]) {
        it(`composes twelve sheets — ${name}, ${kind}, ${rows} row(s)`, async () => {
          const approved = approvedRows(kind, rows, 1);
          expect(packEmsUsed(approved)).toBeLessThanOrEqual(MAX_APPROVED_PACK_EMS);
          expect(packEmsUsed(approved), 'the rows are not near the budget').toBeGreaterThan(MAX_APPROVED_PACK_EMS * (rows === 1 ? 0.8 : 0.4));
          const doc = await compose(input, approved);
          expect(doc.pages).toHaveLength(12);
          const page4 = doc.pages.find((p) => p.navLabel === 'Commentary and actions')!;
          expect(pageMm(page4)).toBeLessThanOrEqual(pageBoxMm(page4));
        });
      }
    }
  }
});

describe('mixed word lengths at the budget (next-fit wrapping can waste a line between words)', () => {
  /** A deterministic text of words 1..58 characters long, cut to cost at most `ems`. */
  function randomText(seed: number, ems: number): string {
    let state = seed;
    const next = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
    let out = '';
    for (;;) {
      const len = 1 + Math.floor(next() ** 2 * 58);
      const word = 'abcdefghijklmnopqrstuvwxyz'.repeat(3).slice(0, len);
      const candidate = out === '' ? word : `${out} ${word}`;
      if (commentaryEms(candidate) > ems) return out;
      out = candidate;
    }
  }

  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`composes twelve sheets for forty seeded texts — ${name}`, async () => {
      for (let seed = 1; seed <= 40; seed++) {
        const body = randomText(seed, MAX_APPROVED_PACK_EMS);
        const row: CommentaryRow = {
          id: 'r', sectionRef: 'income_statement', rowRef: 'revenue', draftText: 'd', approvedText: body,
          status: 'approved', approvedBy: 'u', approvedAt: '2026-10-01T00:00:00.000Z', withdrawnBy: null, withdrawnAt: null,
        };
        const doc = await compose(input, [row]);
        expect(doc.pages, `seed ${seed}`).toHaveLength(12);
      }
    });
  }
});

describe('the pack past its budget', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    for (const kind of Object.keys(KINDS)) {
      it(`refuses at 3.5x the budget — ${name}, ${kind}`, async () => {
        expect(await refusalOf(input, approvedRows(kind, MAX_ROWS, 3.5)), 'the budget has no page behind it here').not.toBeNull();
      });
    }
  }

  for (const kind of ['prose', 'caps', 'wide', 'digits']) {
    it(`refuses at 1.3x the budget on the tightest page — ${kind}`, async () => {
      expect(await refusalOf(liveDemoShortPanelsInput, approvedRows(kind, MAX_ROWS, 1.3)),
        '30% over the budget still composes: the margin is not real').not.toBeNull();
    });
  }

  it('says the approved commentary is too long, names the page, and does not send the reader to support', async () => {
    const refusal = await refusalOf(liveDemoShortPanelsInput, approvedRows('prose', MAX_ROWS, 3.5));
    expect(refusal).not.toBeNull();
    expect(refusal!.userMessage).toContain('approved commentary is too long for page 4 ("Commentary and actions")');
    expect(refusal!.userMessage).not.toContain('contact support');
    // The engineer's diagnostic is kept as it was.
    expect(refusal!.message).toContain('fitPageToBox');
  });
});

describe('fitBodyPage names the sheet the narrative actually sits on', () => {
  const overflowing = (status: 'approved' | 'pending'): PackPage => ({
    number: 9, title: 'A page', navLabel: 'Some narrative page', section: 'Commentary', orientation: 'portrait',
    density: 'high', footnotes: [],
    blocks: [{ kind: 'narrative', narrative: { status, body: 'word '.repeat(3000), actions: [] } }],
  });

  it('says page N for the N it is given, not a page it believes in', () => {
    for (const n of [4, 9]) {
      let refusal: PackRefusal | null = null;
      try { fitBodyPage(overflowing('approved'), n); } catch (e) { refusal = e instanceof PackRefusal ? e : null; }
      expect(refusal, 'the overflowing page composed').not.toBeNull();
      expect(refusal!.userMessage).toContain(`approved commentary is too long for page ${n} ("Some narrative page")`);
    }
  });

  it('leaves any other overflow with the generic refusal: the commentary is not to blame', () => {
    const page: PackPage = {
      ...overflowing('pending'),
      blocks: [{
        kind: 'narrative', narrative: { status: 'pending', body: null, actions: [] },
        boardActions: Array.from({ length: 200 }, () => 'The board should decide this matter and record who is accountable for it.'),
      }],
    };
    let refusal: PackRefusal | null = null;
    try { fitBodyPage(page, 4); } catch (e) { refusal = e instanceof PackRefusal ? e : null; }
    expect(refusal, 'the overflowing page composed').not.toBeNull();
    expect(refusal!.userMessage).not.toContain('approved commentary is too long');
  });
});
