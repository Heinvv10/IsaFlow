/**
 * A ROW LABEL PRINTED TO BREAK ANYWHERE, SET IN A BROWSER AND JUDGED AGAINST THE MODEL: one page script for both of the
 * print tests' browsers (production's image, `printParity/packAnywhereLabelImage.test.ts`, and the print tests'
 * Chromium, `packAnywhereLabels.test.ts`). Each label is set in the statement table's own label cell
 * (`td > span.pack-label-anywhere`, the pack's stylesheet) `w` px wide, its block at the `min-width` the table's fit
 * stamps (`anywhereFloorPx`), with its footnote mark after it as `FootnoteMarker` prints it. The model must read at least
 * the lines the browser sets (`packTableLayout.labelLineCount`, the column as wide as the floor holds it), no line may
 * run past the block, and the block is as wide as the model's column.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FootnoteMarker } from '@/components/accounting/packs/primitives/FootnoteMarker';
import { anywhereFloorPx } from '@/modules/accounting/services/packs/pages/packAnywhereLabel';
import { labelLineCount } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { WRAP_GUARD_PX } from '@/modules/accounting/services/packs/pages/packLineWrap';

export type Weight = 400 | 500 | 600;
export interface AnywhereCase { text: string; footnote: number | null }

/** `anywhereLines(host, cases, w, weight)`: one `L|lines|overrun|width` line per case. `cases`: [text, floor, mark HTML]. */
export const ANYWHERE_LINES_OF = `function anywhereLines(host, cases, w, weight) {
  return cases.map(function (c) {
    var table = document.createElement('table'); table.className = 'pack-table'; table.style.cssText = 'width:auto;table-layout:fixed';
    var td = document.createElement('td'); td.style.cssText = 'width:' + w + 'px;padding:0;font-weight:' + weight;
    var span = document.createElement('span'); span.className = 'pack-label-anywhere'; span.style.minWidth = c[1] + 'px';
    span.appendChild(document.createTextNode(c[0])); if (c[2] !== '') span.insertAdjacentHTML('beforeend', c[2]);
    var tr = document.createElement('tr'); td.appendChild(span); tr.appendChild(td); table.appendChild(tr); host.appendChild(table);
    // Lines as \`TABLES_OF\` counts them: the text's line tops, and one more where the mark sits below its last line.
    var r = document.createRange(); r.selectNodeContents(span.firstChild); var rects = Array.from(r.getClientRects());
    var tops = {}; var right = -1e9; rects.forEach(function (x) { tops[Math.round(x.top)] = 1; right = Math.max(right, x.right); });
    var sup = span.querySelector('sup'); var alone = 0;
    if (sup !== null) { var sb = sup.getBoundingClientRect(); right = Math.max(right, sb.right); if (rects.length > 0 && sb.bottom > rects[rects.length - 1].bottom + 4) alone = 1; }
    var box = span.getBoundingClientRect();
    host.removeChild(table);
    return 'L|' + (Object.keys(tops).length + alone) + '|' + (right - box.right).toFixed(3) + '|' + box.width.toFixed(3);
  });
}`;

const markHtml = (footnote: number | null): string => renderToStaticMarkup(createElement(FootnoteMarker, { number: footnote }));
const floorOf = (text: string, weight: Weight): number => anywhereFloorPx([{ label: text, weight }])!;

/** The page-script argument for `cases` at `weight`. */
export const anywhereArgs = (cases: readonly AnywhereCase[], weight: Weight): string => JSON.stringify(cases.map((c) => [c.text, floorOf(c.text, weight), markHtml(c.footnote)]));

/** Each of `cases` the browser set (`lines`, its `L|` lines in order) judged against the model: what is wrong. */
export function judgeAnywhere(cases: readonly AnywhereCase[], lines: readonly string[], w: number, weight: Weight): string[] {
  const got = lines.filter((l) => l.startsWith('L|')).map((l) => l.slice(2).split('|').map(Number));
  if (got.length !== cases.length) return [`the browser's lines came back incomplete: ${got.length} of ${cases.length}`];
  return cases.flatMap(({ text, footnote }, i) => {
    const [set, overrun, width] = got[i]!;
    const avail = Math.max(w, floorOf(text, weight));
    const model = labelLineCount(text, footnote, weight, avail, WRAP_GUARD_PX);
    const at = `${JSON.stringify(text)}${footnote === null ? '' : `^${footnote}`} at ${w}px/${weight}`;
    return [
      ...(model < set! ? [`${at}: model ${model} lines, the browser ${set}`] : []),
      // Chromium fits a line its unit (1/64px) over the box: still inside the cell, whose padding is 7.56px.
      ...(overrun! > 1 / 64 + 0.001 ? [`${at}: a line runs ${overrun}px past its block`] : []),
      ...(Math.abs(width! - avail) > 0.02 ? [`${at}: the block is ${width}px, the model's column ${avail}px`] : []),
    ];
  });
}
