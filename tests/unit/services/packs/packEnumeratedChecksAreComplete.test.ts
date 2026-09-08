/**
 * A CLOSED LIST ANSWERING "WHAT WAS CHECKED?", DISPROVED THREE LINES BELOW
 * ITSELF — IN BOTH PACKS, AND THE MISSING CHECK CARRIED THE BIGGEST NUMBER.
 *
 * Page 4's "How this page is prepared" and page 11's "What was checked" each
 * enumerated four sources: aged debtor concentration, unreconciled bank
 * items, unusual journals and overdue statutory filings. Three lines under
 * each list, both packs printed a matter none of the four produces — the
 * net-credit month, 1 869 on the demo and 4 128 on Brightsphere, the largest
 * single exposure in each and the one the page-4 headline names. It is not
 * "unusual journals": the table lists those separately and individually by JE
 * number. It is a month-level test on the SIGN of the expense total, taken
 * from the series the pack already draws.
 *
 * The fix is not a fifth string typed into two notes, because that is the
 * defect: two hand-written enumerations of a list that lives somewhere else.
 * Both notes render `MATTER_SOURCES`, and these hold both against the checks
 * the pack can actually run rather than against a string.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  DERIVED_SOURCE_LABEL,
  MATTER_SOURCES,
} from '@/modules/accounting/services/packs/pages/packDerivedMatters';
import { SOURCES } from '@/modules/accounting/services/packs/pages/packMatters';
import { brightsphereReceivablesGapInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const PACKS: Array<[string, BoardPackInput]> = [
  ['the live demo company', liveDemoShortPanelsInput],
  ['Brightsphere', brightsphereReceivablesGapInput],
];

/** The two sheets that promise to enumerate the pack's checks. */
const ENUMERATIONS: Array<[string, string]> = [
  ['Commentary and actions', 'How this page is prepared'],
  ['Matters for the board', 'What was checked'],
];

function noteText(input: BoardPackInput, navLabel: string, heading: string): string {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === navLabel);
  if (page === undefined) throw new Error(`no ${navLabel} page`);
  for (const block of page.blocks) {
    if (block.kind !== 'disclosure') continue;
    if (block.disclosure.heading !== heading) continue;
    return block.disclosure.notes.map((n) => n.body).join(' ');
  }
  throw new Error(`no '${heading}' disclosure on ${navLabel}`);
}

describe('every sheet that enumerates the pack\'s checks names all of them', () => {
  for (const [packName, input] of PACKS) {
    for (const [navLabel, heading] of ENUMERATIONS) {
      it(`${packName}, ${navLabel}`, () => {
        const text = noteText(input, navLabel, heading).toLowerCase();
        // Against the CHECKS, not against a string: a source added to
        // `SOURCES` and never mentioned on either sheet fails here.
        for (const source of MATTER_SOURCES) {
          expect(text, `the list omits '${source}'`).toContain(source.toLowerCase());
        }
      });
    }
  }

  it('the canonical list is the four ledger sources plus the derived one', () => {
    // Pins the composition rather than the strings, so a fifth ledger source
    // reaches both sheets without anyone remembering to edit them.
    expect(MATTER_SOURCES).toHaveLength(SOURCES.length + 1);
    expect(MATTER_SOURCES.slice(0, SOURCES.length)).toEqual(SOURCES.map((s) => s.check));
    expect(MATTER_SOURCES[MATTER_SOURCES.length - 1]).toBe(DERIVED_SOURCE_LABEL);
  });

  it('the check that produces the biggest matter is one of them', () => {
    // The whole finding in one assertion: the net-credit month IS a check,
    // and it is the one carrying the largest exposure in both packs.
    expect(MATTER_SOURCES).toContain(DERIVED_SOURCE_LABEL);
    for (const [, input] of PACKS) {
      const page = buildBoardPackPages(input).pages
        .find((p) => p.navLabel === 'Matters for the board')!;
      const table = page.blocks.find((b) => b.kind === 'matters')!;
      const rows = table.kind === 'matters' ? table.matters : [];
      const credit = rows.find((m) => m.issue.includes('expenses for the month are a net credit'));
      expect(credit, 'the net-credit matter stopped printing').toBeDefined();
      const biggest = Math.max(...rows.map((m) => Math.abs(m.quantum.value ?? 0)));
      expect(Math.abs(credit!.quantum.value ?? 0),
        'the net-credit matter is no longer the largest printed exposure').toBe(biggest);
    }
  });
});
