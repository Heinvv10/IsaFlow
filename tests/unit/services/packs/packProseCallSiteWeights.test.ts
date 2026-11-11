/**
 * A DISCLOSURE NOTE'S HEADING IS CHARGED IN THE BOLD ITS CSS SETS IT IN (the prose PR). A note opens with its heading in
 * `.pack-disclosure-note-heading` (600, `packProseStyles.test.ts` holds it to the stylesheet) and runs on in the body's
 * regular, so the paragraph is measured as two segments. Charged in the body's weight instead, a heading that the bold
 * pushes onto another line reads the block a line short. The body's length is found, not written down: the first at which
 * the heading's bold costs the paragraph a line, so the case keeps discriminating if the faces or the sizes move.
 */
import { describe, expect, it } from 'vitest';
import { disclosureMm } from '@/modules/accounting/services/packs/pages/packBlockHeights';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { lines, PAGE_WIDTH_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import type { PackDisclosure } from '@/modules/accounting/services/packs/pages/packPageModel';

const HEADING = 'Size of the unexplained step';
/** "interest" and a word of `letters` letters: the heading's first line, filled to a length the search below sets. */
const body = (letters: number): string => `interest ${'x'.repeat(letters)}`;
const segments = (letters: number, weight: 400 | 600) => [{ text: HEADING, weight }, { text: ` ${body(letters)}`, weight: PROSE.disclosureBody.weight }];

describe('a disclosure note in portrait', () => {
  it('is measured with its heading in the notes\' bold', () => {
    const mm = PAGE_WIDTH_MM.portrait;
    const bold = PROSE.disclosureNoteHeading.weight;
    const letters = Array.from({ length: 200 }, (unused, i) => i + 1)
      .find((n) => proseLines(segments(n, bold), PROSE.disclosureBody, mm) > proseLines(segments(n, 400), PROSE.disclosureBody, mm));
    expect(letters, 'no body length at which the bold costs a line, so nothing is being tested').toBeDefined();
    const disclosure: PackDisclosure = { heading: 'How much of this bridge is unexplained', required: true, notes: [{ heading: HEADING, body: body(letters!) }] };
    const headingOnly = disclosureMm({ ...disclosure, notes: [] }, 'portrait');
    expect(disclosureMm(disclosure, 'portrait')).toBeCloseTo(headingOnly + 1.5 + lines(proseLines(segments(letters!, bold), PROSE.disclosureBody, mm), 14), 9);
  });
});
