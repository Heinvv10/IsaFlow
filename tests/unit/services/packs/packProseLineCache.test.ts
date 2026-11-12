/**
 * THE SHORT-LINES CACHE (`packProseLines.SHORT_LINES`, #1263): its key names everything the fill reads, and it holds a
 * bounded amount of text. Two styles of one size that differ in weight (a note and its label, a definition and its
 * term) must not share a line count, and the key text kept is capped in code units, not only in entries (20,000 texts
 * of 1,000 characters was tens of MB).
 */
import { describe, expect, it } from 'vitest';
import { keptShortLines, proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE, type ProseStyle } from '@/modules/accounting/services/packs/pages/packProseStyles';

const PAIRS: ReadonlyArray<readonly [string, ProseStyle, ProseStyle]> = [
  ['footnote and tableNoteLabel (7.5pt)', PROSE.footnote, PROSE.tableNoteLabel],
  ['definition and definitionTerm (8.5pt)', PROSE.definition, PROSE.definitionTerm],
  ['disclosureBody and disclosureNoteHeading (9.5pt)', PROSE.disclosureBody, PROSE.disclosureNoteHeading],
];

describe('the key of the short-lines cache names the weight', () => {
  it.each(PAIRS)('%s: the bolder one is asked after the regular one, at a width where it takes more lines', (unused, regular, bold) => {
    expect(regular.pt).toBe(bold.pt);
    expect(regular.weight).not.toBe(bold.weight);
    const text = 'Revenue grew while costs were held flat across the Gauteng depots';
    // A width at which the two differ, found with one style asked first for the whole sweep (so none is read from the other's entry).
    const widths = Array.from({ length: 160 }, (u, i) => 20 + i * 0.25);
    const differing = widths.filter((mm) => proseLines(`${text} a${mm}`, bold, mm) > proseLines(`${text} a${mm}`, regular, mm));
    expect(differing.length, 'a width at which weight changes the lines').toBeGreaterThan(0);
  });
});

describe('the short-lines cache holds a bounded amount of key text', () => {
  it('clears before the key text kept passes its ceiling, whatever the entries', () => {
    const seen: number[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      proseLines(`${i} ${'wide '.repeat(190)}`, PROSE.footnote, 100);
      seen.push(keptShortLines().units);
    }
    expect(Math.max(...seen)).toBeLessThanOrEqual(2_000_000);
    expect(Math.max(...seen)).toBeGreaterThan(1_000_000);
    expect(seen.some((units, i) => i > 0 && units < seen[i - 1]!)).toBe(true);
    expect(keptShortLines().entries).toBeLessThan(3_000);
  });
});
