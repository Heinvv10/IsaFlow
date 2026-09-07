/**
 * DID THE PACK'S FIGURES AND FURNITURE ACTUALLY PRINT?
 *
 * Every other gate in this module measures the document we COMPOSED. This one
 * measures the PDF we produced, because the two came apart: at 4663a916 a
 * render of the demo pack produced a well-formed twelve-sheet document whose
 * text layer was missing every 500- and 600-weight position — eight KPI tiles
 * with no figures, five statement tables with no column headers, six sparkline
 * panels with no titles, a glossary with no terms — and the page count was
 * right, the integrity gates passed, `packSheetCount` passed 21/21, and
 * `pdfinfo` reported a healthy file. The cause was a font race
 * (`usePrintMode.ts`); the reason nobody caught it is that we had no
 * instrument pointed at the paper.
 *
 * WHAT IT ASSERTS, AND WHY THESE STRINGS. Only text the pack sets in a face
 * OTHER than the 400-weight body: the page name (600), the section eyebrow
 * (500), every statement table's column headers (500), every scorecard group
 * heading (600), every chart and panel title (500), and every glossary term
 * (600). Those are exactly the positions a missing face empties, and every one
 * of them is read off the composed document rather than written down here, so
 * the gate follows the pack when the pack changes.
 *
 * PAGE BY PAGE, NOT DOCUMENT-WIDE. `pdftotext` separates sheets with a form
 * feed, so each page's expectations are checked against that page's own text.
 * A whole-document scan would pass a pack that printed the balance sheet's
 * headers and not the cash flow's.
 *
 * WHITESPACE IS STRIPPED BEFORE COMPARING, AND SO ARE THE DIGITS. The pack
 * letter-spaces its eyebrow and its table headers, and `pdftotext` renders the
 * tracking as spaces: "FINANCIALS" comes back as "FI N AN CI AL S", and a
 * chart title wraps mid-sentence. Digits go because the two sides format them
 * in two processes — the composed title read "1.545" where Chromium printed
 * "1 545", the same figure under two ICU builds — so every run of digits and
 * their separators collapses to a single `#` on both sides. That is a real
 * limit and it is the right one: this gate asks whether the type reached the
 * paper, and `packFigureIntegrity` and `checkChartClaims` are what ask whether
 * the numbers are correct.
 *
 * FEED IT `pdftotext` WITHOUT `-layout`. The layout mode reconstructs columns
 * by position and interleaves the two halves of page 10 line by line, which
 * splits a panel title down the middle of the page. Reading order keeps each
 * string contiguous.
 */
import { PACK_TABLE_COLUMN_LABEL } from '../pages/packBlockModel';
import type { PackPage, PackPagesDocument } from '../pages/packPageModel';

/** One thing the paper has to show, and where. */
export interface PackTextExpectation {
  page: number;
  /** What this string is, for the failure message. */
  what: string;
  text: string;
}

/** The front matter is laid out by `PackCoverV2` and `PackContents` rather
 *  than from a block list, and neither prints a page name or an eyebrow. */
const FIRST_CONTENT_PAGE = 3;

function expectationsForPage(page: PackPage, doc: PackPagesDocument): PackTextExpectation[] {
  const out: PackTextExpectation[] = [];
  const expect = (what: string, text: string) => {
    if (text.trim().length > 0) out.push({ page: page.number, what, text });
  };

  if (page.number >= FIRST_CONTENT_PAGE) {
    expect('the page name', page.navLabel);
    expect('the section eyebrow', page.section);
    // THE RUNNING FOOTER, WHICH IS NOT DRAWN BY THE PAGE. Chromium paints it
    // into the bottom margin from the `footerHtml` the CALLER passes, so a
    // caller that omits it — `render-pack.ts` did, and every clean-room render
    // in `evidence/` came out of it — produces sheets a director cannot
    // attribute to a company or a period, with every in-page gate still green.
    // Asserted on the paper because there is nowhere else it can be seen.
    expect('the running footer company name', doc.companyName);
    expect('the running footer period', doc.period);
  }

  for (const block of page.blocks) {
    if (block.kind === 'table') {
      for (const column of block.table.columns) {
        expect('a statement column header', PACK_TABLE_COLUMN_LABEL[column]);
      }
    } else if (block.kind === 'scorecard') {
      for (const group of block.groups) expect('a scorecard group heading', group.name);
    } else if (block.kind === 'chart') {
      expect('a chart title', block.chart.title);
    } else if (block.kind === 'smallMultiples') {
      for (const panel of block.panels) expect('a panel title', panel.title);
    } else if (block.kind === 'definitions') {
      for (const entry of block.entries) expect('a glossary term', entry.term);
    }
  }
  return out;
}

/** Everything the rendered pack has to show, read off the composed document. */
export function packTextExpectations(doc: PackPagesDocument): PackTextExpectation[] {
  return doc.pages.flatMap((page) => expectationsForPage(page, doc));
}

function squash(text: string): string {
  return text.replace(/\s+/g, '').replace(/\d[\d.,]*/g, '#').toLowerCase();
}

/**
 * What the rendered pack failed to print, from `pdftotext`'s output — empty
 * when every expectation is on the paper.
 *
 * `pdfText` must be the whole document, form feeds included: the sheet count
 * is checked first, because expectations addressed to a page that is not
 * there would otherwise all fail with the wrong reason.
 */
export function checkPackTextLayer(doc: PackPagesDocument, pdfText: string): string[] {
  // A trailing form feed after the last sheet is normal; it is not a sheet.
  const sheets = pdfText.split('\f').filter((sheet, index, all) =>
    index < all.length - 1 || sheet.trim().length > 0);
  if (sheets.length !== doc.pages.length) {
    return [
      `The rendered pack has ${sheets.length} sheets and the document composed `
        + `${doc.pages.length} pages. Nothing else about the text layer can be checked.`,
    ];
  }

  const squashed = sheets.map(squash);
  const failures: string[] = [];
  for (const expectation of packTextExpectations(doc)) {
    const sheet = squashed[expectation.page - 1] ?? '';
    if (sheet.includes(squash(expectation.text))) continue;
    failures.push(
      `Sheet ${expectation.page} does not print ${expectation.what}: "${expectation.text}". `
        + 'The text is absent from the PDF, not merely faint — a face the page sets that '
        + 'position in did not load, or the block did not render.',
    );
  }
  return failures;
}
