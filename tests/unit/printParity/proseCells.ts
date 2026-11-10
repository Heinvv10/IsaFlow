/**
 * PROSE SET IN PRODUCTION'S IMAGE, CELL BY CELL, against the page model's lines: the harness of the prose image tests
 * (`packProseLinesImage.test.ts`, `packProseLinksImage.test.ts`). A cell is a text in a style at a measure, in the markup
 * the pack sets it in; production's lines are the distinct tops of its text's line boxes.
 */
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import type { ProseStyle } from '@/modules/accounting/services/packs/pages/packProseStyles';
import type { Gotenberg } from './gotenbergParity';
import { inImage } from './inImage';

export interface Cell { text: string; style: ProseStyle; mm: number; html: string; label: string }

export const MM_PX = 96 / 25.4;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** In a block of `cls` (`tag`), `widthPx` wide (the measure, or a width the caller chose in pixels). */
export function inBlock(cls: string, tag = 'div', leading = '') {
  return (text: string, style: ProseStyle, mm: number, widthPx = mm * MM_PX): Cell => ({
    text, style, mm, label: `${cls} ${widthPx.toFixed(3)}px`,
    html: `<${tag} class="${cls} m" style="display:block;width:${widthPx}px;font-size:${style.pt}pt;${leading}">${esc(text)}</${tag}>`,
  });
}

/** In a matters cell, the table's own: its 2mm padding either side of the measure the model sets the text across. */
export function inMattersCell(text: string, style: ProseStyle, mm: number): Cell {
  return {
    text, style, mm, label: `matters ${mm.toFixed(1)}mm`,
    html: `<table class="pack-table pack-matters" style="width:${(mm + 4) * MM_PX}px;table-layout:fixed;border-collapse:collapse">`
      + `<tbody><tr class="pack-matters-row"><td><span class="m">${esc(text)}</span></td></tr></tbody></table>`,
  };
}

// A line's text boxes in two faces (a fallback glyph beside the pack's) start at different tops: a new line is a top more
// than 3px below the last (the pack's tightest leading is 11pt, 14.7px).
const LINES_SCRIPT = `function answer() { return Array.from(document.querySelectorAll('.case .m')).map(function (m) {
  var r = document.createRange(); r.selectNodeContents(m);
  var tops = Array.from(r.getClientRects()).filter(function (x) { return x.width > 0; }).map(function (x) { return x.top; }).sort(function (a, b) { return a - b; });
  var n = 0; var last = -1e9; tops.forEach(function (t) { if (t - last > 3) { n += 1; last = t; } });
  return 'N|' + n; }); }`;

/** Production's lines for each cell, in order. */
export async function printedLines(gotenberg: Gotenberg, cells: readonly Cell[]): Promise<number[]> {
  const body = `<div class="pack-pages"><div class="pack-page">${cells.map((c) => `<div class="case" style="font-family:var(--pack-font-sans)">${c.html}</div>`).join('')}</div></div>`;
  return (await inImage(gotenberg, LINES_SCRIPT, body)).filter((l) => l.startsWith('N|')).map((l) => Number(l.slice(2)));
}

/**
 * The cells production sets in more lines than the page model reads at `mm` (`lines`: what the model is held to, by
 * default `proseLines` at the cell's measure), and, for a regular style, than the commentary gate's bound.
 */
export async function shortCells(gotenberg: Gotenberg, cells: readonly Cell[], lines?: (cell: Cell) => number): Promise<string[]> {
  const got = await printedLines(gotenberg, cells);
  if (got.length !== cells.length) return [`the image's line counts came back incomplete: ${got.length} of ${cells.length}`];
  return cells.flatMap((c, i) => {
    const at = `${c.label} ${JSON.stringify(c.text).slice(0, 60)}: production ${got[i]}`;
    const model = lines === undefined ? proseLines(c.text, c.style, c.mm) : lines(c);
    const bound = lines === undefined && c.style.weight === 400 ? proseLinesBound(c.text, c.style, c.mm) : Infinity;
    return [...(model < got[i]! ? [`${at}, model ${model}`] : []), ...(bound < got[i]! ? [`${at}, bound ${bound}`] : [])];
  });
}
