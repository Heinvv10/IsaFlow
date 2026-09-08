/**
 * THE BRACKET IS THE SIGN, SO NOTHING ELSE MAY WEAR IT.
 *
 * Page 12 declares the pack's notation in its own words: "In brackets —
 * (12 345) — for money, percentages and ratios. No minus sign is used in this
 * pack." Page 10's Scale note then printed "Revenue (1.0%) and Operating
 * expenses (1.6%)" — two POSITIVE shares — while the same two figures printed
 * unbracketed as positives in the panel captions two centimetres above. One
 * quantity, one sheet, two glyphs, and one of them meant the opposite sign.
 *
 * A RUNTIME RULE OVER THE RENDERED TEXT IS THE WRONG SHAPE, and that was
 * measured: a regex for "a bracketed positive" in the demo's text layer finds
 * genuine negatives too — `formatMoney` brackets those deliberately, and the
 * check cannot tell an authored parenthesis from the notation once both are
 * the same character on a page. The distinction is exact in the SOURCE:
 * every formatter in `money.ts` already brackets a negative itself, so a
 * parenthesis the author types around a figure interpolation is either a
 * doubled bracket on a negative or a positive dressed as a negative. Neither
 * is ever right, whatever the figure turns out to be at runtime.
 *
 * So the rule is positional rather than textual: no `(` immediately before a
 * formatted figure in the pack's own authored prose. Comments are stripped
 * first — this file's own prose above would otherwise fail it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKS_DIR = join(process.cwd(), 'src/modules/accounting/services/packs');

/** Every formatter that emits a figure in the pack's notation. Each one
 *  brackets its own negatives; none of them needs help. */
const FIGURE_CALL =
  '(?:money|formatMoney|formatPct|formatPctLevel|formatRatio|formatDays'
  + '|scorecardFigure|formatScorecardValue|pctWithWord|inProse|inScale|atScale)\\s*\\(';

const AUTHORED_BRACKET = new RegExp(`\\(\\$\\{\\s*${FIGURE_CALL}`, 'g');

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFilesUnder(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** Source with comments removed, so a docblock quoting the defect does not
 *  fail the check that stops it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the pack never types a bracket around a figure that formats its own', () => {
  const files = tsFilesUnder(PACKS_DIR);

  it('has a source tree to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const file of files) {
    it(`writes no authored bracket around a figure in ${file.slice(PACKS_DIR.length + 1)}`, () => {
      const found = [...code(readFileSync(file, 'utf8')).matchAll(AUTHORED_BRACKET)];
      expect(
        found.map((m) => m[0]),
        'a parenthesis around a figure prints as the pack\'s negative sign — write the '
        + 'aside with a comma, or the sign in words',
      ).toEqual([]);
    });
  }

  it('catches the shape it exists for', () => {
    // The line as page 10's Scale note actually had it, before `1194dba0`.
    const defect = 'const named = inWords(panels.ownScale.map((p) => `${p.name} '
      + '(${formatPctLevel(p.sharePct)})`));';
    expect([...code(defect).matchAll(AUTHORED_BRACKET)].length).toBe(1);
    // And leaves the sentence that replaced it alone.
    const fixed = 'const named = inWords(panels.ownScale.map((p) => `${p.name} '
      + 'at ${formatPctLevel(p.sharePct)}`));';
    expect([...code(fixed).matchAll(AUTHORED_BRACKET)].length).toBe(0);
  });
});
