/**
 * Slides to .pptx bytes.
 *
 * Charts are added with `addChart`, not as pictures: a native chart carries
 * its own data sheet, so the reader can retitle an axis or change a colour
 * without coming back to ask for a new pack.
 *
 * TEXT SAFETY: pptxgenjs escapes `& < > " '` on its way into the XML, so
 * ledger text needs no escaping here and escaping it again would print
 * "&amp;amp;". What it does NOT do is drop the C0/C1 control characters XML
 * 1.0 cannot represent at all — one of those in an imported supplier name
 * yields a package PowerPoint refuses to open — so those are stripped, and
 * only those.
 */
import PptxGenJS from 'pptxgenjs';
import { log } from '@/lib/logger';
import type { DeckSlide } from './packDeckModel';

const INK = '15202B';
const MUTED = '6B7280';
const ACCENT = '0D9488';
const RULE = 'E5E7EB';

/** C0/C1 control characters, minus the tab, newline and carriage return that
 *  XML 1.0 does allow. Replaced with a space so a word boundary survives. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function safeText(value: string): string {
  return value.replace(CONTROL_CHARS, ' ');
}

function addHeading(slide: PptxGenJS.Slide, title: string): void {
  slide.addText(safeText(title), { x: 0.5, y: 0.4, w: 9, h: 0.5, fontSize: 20, bold: true, color: INK });
}

function addTitleSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'title' }>): void {
  const s = pptx.addSlide();
  s.addText(safeText(slide.title), { x: 0.6, y: 2.1, w: 8.8, h: 0.9, fontSize: 36, bold: true, color: INK });
  s.addText(safeText(slide.subtitle), { x: 0.6, y: 3.0, w: 8.8, h: 0.6, fontSize: 22, color: ACCENT });
  s.addText(safeText(slide.footnote), { x: 0.6, y: 3.7, w: 8.8, h: 0.4, fontSize: 14, color: MUTED });
}

function addTableSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'table' }>): void {
  const s = pptx.addSlide();
  addHeading(s, slide.title);
  // An empty table is a pptxgenjs throw, and a section with no rows is a
  // legitimate pack (a company with no KPIs configured). Say so instead.
  if (slide.rows.length === 0) {
    s.addText('No figures for this section.', { x: 0.5, y: 1.1, w: 9, h: 0.4, fontSize: 12, color: MUTED });
    return;
  }
  s.addTable(
    slide.rows.map((row) => [
      { text: safeText(row.label), options: { bold: row.emphasis, color: INK } },
      { text: safeText(row.value), options: { bold: row.emphasis, color: INK, align: 'right' as const } },
    ]),
    { x: 0.5, y: 1.1, w: 9, colW: [6, 3], fontSize: 12, border: { type: 'solid', pt: 0.5, color: RULE } },
  );
}

function addChartSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'chart' }>): void {
  const s = pptx.addSlide();
  addHeading(s, slide.title);
  if (slide.categories.length === 0) {
    s.addText('No data for this chart.', { x: 0.5, y: 1.1, w: 9, h: 0.4, fontSize: 12, color: MUTED });
    return;
  }
  s.addChart(
    pptx.ChartType.bar,
    slide.series.map((series) => ({
      name: safeText(series.name),
      labels: slide.categories.map(safeText),
      values: series.values,
    })),
    { x: 0.5, y: 1.1, w: 9, h: 4.4, showLegend: false, chartColors: [ACCENT], catAxisLabelRotate: 30 },
  );
}

function addTextSlide(pptx: PptxGenJS, slide: Extract<DeckSlide, { kind: 'text' }>): void {
  const s = pptx.addSlide();
  addHeading(s, slide.title);
  s.addText(safeText(slide.body), { x: 0.5, y: 1.1, w: 9, h: 4, fontSize: 14, color: INK });
}

export async function renderPackPptx(slides: DeckSlide[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';

  for (const slide of slides) {
    if (slide.kind === 'title') addTitleSlide(pptx, slide);
    else if (slide.kind === 'table') addTableSlide(pptx, slide);
    else if (slide.kind === 'chart') addChartSlide(pptx, slide);
    else addTextSlide(pptx, slide);
  }

  // `write` is typed as the union of every output type it can produce;
  // 'nodebuffer' is the one that yields a Buffer.
  const output = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  log.info('renderPackPptx: rendered', { slides: slides.length, bytes: output.length }, 'packs');
  return output;
}
