/**
 * THE EBITDA BRIDGE ADDS, OR SAYS WHY IT DOES NOT.
 *
 * Page 12 printed `(1 545) + 77 = (1 467)` on the live demo pack, where the
 * printed operands give (1 468). Each figure is right — the steps are
 * unrounded rands rounded independently to the nearest R'000 — but a
 * three-line non-IFRS reconciliation is the one table a director is invited to
 * foot, and "resolves within the general rounding note in the next column" is
 * not the standard for it.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { bridgeRoundingNote } from '@/modules/accounting/services/packs/pages/packDefinitions';
import { formatMoney } from '@/lib/format/money';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { demoInput } from './fixtures/boardPackInputs';
import { liveDemoBridgeInput, liveDemoInput } from './fixtures/liveDemoBoardPack';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackDefinition } from '@/modules/accounting/services/packs/pages/packPageModel';

function ebitda(input: BoardPackInput): PackDefinition {
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'definitions') continue;
      const entry = block.entries.find((e) => e.term === 'EBITDA');
      if (entry) return entry;
    }
  }
  throw new Error('no EBITDA definition in this pack');
}

/** What the cell PRINTS, read back as a number — the unit a reader adds. */
function printed(value: number): number {
  const text = formatMoney(value, { scale: PACK_SCALE });
  const digits = Number(text.replace(/[^0-9]/g, ''));
  return text.startsWith('(') ? -digits : digits;
}

/**
 * The three packs, and the third is the one that does NOT add.
 *
 * `demoInput` and `liveDemoInput` both foot as printed, so the loop below ran
 * one arm on both fixtures and its "does not add" arm was dead — coverage the
 * file read as having and did not. `liveDemoBridgeInput` is the live demo
 * company's own figures at the rounding that produced the defect, so both
 * arms are now entered by a composed pack rather than only at the helper.
 */
const PACKS = [
  ['demo', demoInput],
  ['live demo', liveDemoInput],
  ['live demo, whose bridge does not add as printed', liveDemoBridgeInput],
] as const;

/** Which arms of the loop below were entered, so neither can go dead again. */
const arms = new Set<'adds' | 'does not add'>();

describe('the EBITDA reconciliation', () => {
  for (const [name, input] of PACKS) {
    it(`adds as printed, or carries a note saying why not, on the ${name} pack`, () => {
      const entry = ebitda(input);
      const steps = entry.reconciliation!;
      expect(steps).toHaveLength(3);
      const [operating, addBack, total] = steps.map((s) => printed(s.figure.value as number));
      if (operating! + addBack! === total!) {
        arms.add('adds');
        expect(entry.reconciliationNote).toBeUndefined();
        return;
      }
      arms.add('does not add');
      // It does not add as printed, so the page has to say so ON THE LINE,
      // and say it in figures a reader can check rather than in the abstract.
      expect(entry.reconciliationNote).toBeDefined();
      expect(entry.reconciliationNote).toContain(formatMoney(steps[0]!.figure.value as number, { cents: true }));
      expect(entry.reconciliationNote).toContain(formatMoney(steps[2]!.figure.value as number, { cents: true }));
    });
  }

  /**
   * AND BOTH ARMS WERE ENTERED. A fixture set where every bridge foots makes
   * every assertion above trivially true — which is what this file used to
   * be: the "does not add" arm was reached by neither pack, and the docstring
   * that stood here claimed a test that did not exist below it.
   */
  it('is proved on a pack of each kind', () => {
    expect([...arms].sort()).toEqual(['adds', 'does not add']);
  });
});

/**
 * The note itself, driven at the helper — the boundaries a composed pack does
 * not put on paper.
 *
 * Operating profit of R1 544 600 and an add-back of R77 400 print as (1 545)
 * and 77 and sum to (1 467): the page's own three lines, and the arithmetic
 * the reviewer reported as not adding.
 */
describe('bridgeRoundingNote', () => {
  it('states the unrounded arithmetic when the printed lines do not add', () => {
    const note = bridgeRoundingNote(-1_544_600, 77_400, -1_467_200);
    expect(note).toBeDefined();
    expect(note).toContain('(1\u00a0544\u00a0600.00)');
    expect(note).toContain('77\u00a0400.00');
    expect(note).toContain('(1\u00a0467\u00a0200.00)');
  });

  it('says nothing when they do add — a note for a discrepancy a reader cannot find is worse than none', () => {
    expect(bridgeRoundingNote(-1_545_000, 77_000, -1_468_000)).toBeUndefined();
    expect(bridgeRoundingNote(-1_545_540, 0, -1_545_540)).toBeUndefined();
  });
});

/**
 * AND IT BRIDGES BOTH COLUMNS, NOT JUST THE ONE THE PACK FINDS CONVENIENT.
 *
 * Page 5 states the comparative period's EBITDA in the same sentence, at the
 * same prominence, as the current one — "The comparative period's is (905)" —
 * and nothing in the pack reconciled it. On the demo company it equals
 * comparative operating profit exactly, which is a NIL add-back: true, and
 * indistinguishable to a reader from a measure the pack could not compute.
 * §7.1 criterion 12 fails a non-IFRS measure stated without its bridge, and
 * a comparative stated in the pack is a measure stated in the pack.
 */
describe('the comparative column of the EBITDA bridge', () => {
  it('is printed, and adds, wherever the pack has a comparative period', () => {
    for (const [name, input] of [['demo', demoInput], ['live demo', liveDemoInput]] as const) {
      const entry = ebitda(input);
      const steps = entry.reconciliation!;
      const comparatives = steps.map((s) => s.comparative);
      expect(comparatives.every((c) => c !== undefined), `${name}: a step has no comparative`)
        .toBe(true);
      const [operating, addBack, total] = comparatives.map((c) => printed(c!.value as number));
      if (operating! + addBack! !== total!) {
        // Same standard as the current column: it says so on the line.
        expect(entry.reconciliationNote, `${name}: the comparative does not add and says nothing`)
          .toMatch(/Comparative period:/);
        continue;
      }
      expect(operating! + addBack!).toBe(total!);
      // AND IT IS A SECOND READING OF A SECOND PERIOD, not a copy of the
      // first. Every comparative figure resolves at its own `.prior` source.
      for (const step of steps) expect(step.comparative!.source).toMatch(/\.prior$/);
    }
  });

  /** A first-period company has no comparative to bridge, and an empty
   *  second column would claim one. */
  it('is absent where the pack has no comparative period', () => {
    const entry = ebitda({ ...demoInput, set: { ...demoInput.set, prior: null } });
    for (const step of entry.reconciliation!) expect(step.comparative).toBeUndefined();
  });
});
