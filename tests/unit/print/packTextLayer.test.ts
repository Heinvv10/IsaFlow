/**
 * THE GATE THAT CAN SEE A BLANK PACK.
 *
 * Both fixtures are real `pdftotext` output from the same code, the same
 * company and the same period. The only difference is that one render's font
 * files were held back for nine seconds: the loaded render is twenty-odd
 * kilobytes and `renderedPack-fontsBlocked.txt` is 746 — twelve well-formed
 * sheets with almost nothing on them, which is the artefact every other gate
 * in this repository passed.
 *
 * `renderedPack-fontsLoaded.txt` was re-captured from a render through the
 * DOWNLOAD ROUTE (`GET /api/accounting/packs/board/pdf`) rather than through
 * `render-pack.ts`. The old capture came from the script, which passed no
 * `footerHtml`, so the fixture recorded a pack with no running footer on any
 * sheet — and a gate whose evidence is a footerless render cannot see a
 * footer go missing.
 *
 * So this test is mutation-proved by construction: the checker must pass the
 * first file and fail the second, and it fails the second for the reason the
 * defect had.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { checkPackTextLayer, packTextExpectations } from '@/modules/accounting/services/packs/figures/packTextLayer';
import { liveDemoInput } from '../services/packs/fixtures/liveDemoBoardPack';

const doc = buildBoardPackPages(liveDemoInput);

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('the rendered pack\'s text layer', () => {
  it('expects the pack\'s non-body type on every content sheet', () => {
    const expectations = packTextExpectations(doc);
    // Page names, eyebrows, five tables' column headers, the scorecard's
    // group headings, the trends panels' titles and the glossary's terms.
    expect(expectations.length).toBeGreaterThan(40);
    expect(new Set(expectations.map((e) => e.page)).size).toBeGreaterThanOrEqual(10);
  });

  /**
   * CHART TITLES ARE EXCLUDED HERE, AND ONLY HERE. A chart title is a
   * sentence about the company's own figures — "Revenue of 99 bridges to net
   * profit of (1 546)." — so the fixture document's titles quote the
   * fixture's numbers and the rendered pack quotes the dev tenant's. Every
   * other expectation is structural and identical across the two. The
   * chart-title arm is proved by the blocked render below, which fails on it.
   */
  it('passes every structural expectation on the render whose fonts loaded', () => {
    const failures = checkPackTextLayer(doc, fixture('renderedPack-fontsLoaded.txt'))
      .filter((f) => !/(chart|panel) title/.test(f));
    expect(failures).toEqual([]);
  });

  /**
   * THE FOOTER IS NOT DRAWN BY THE PAGE, so nothing in the DOM proves it
   * printed. Chromium paints it into the bottom margin from the caller's
   * `footerHtml`; a caller that omits it produces sheets that pass every
   * in-page expectation above and still cannot be attributed to a company or
   * a period. The fixture is mutated here rather than kept as a second file
   * because the mutation IS the defect: the same render, footer lines
   * removed.
   */
  it('fails a render that printed no running footer', () => {
    const footerless = fixture('renderedPack-fontsLoaded.txt')
      .split('\n')
      .filter((line) => !line.includes('ISAFlow Demo (Pty) Ltd · Board Pack'))
      .join('\n');
    const failures = checkPackTextLayer(doc, footerless)
      .filter((f) => !/(chart|panel) title/.test(f));
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => /running footer/.test(f))).toBe(true);
    expect(failures.join('\n')).toMatch(/does not print the running footer company name/);
    expect(failures.join('\n')).toMatch(/does not print the running footer period/);
  });

  it('fails the render whose fonts did not', () => {
    const failures = checkPackTextLayer(doc, fixture('renderedPack-fontsBlocked.txt'));
    expect(failures.length).toBeGreaterThan(20);
    expect(failures.join('\n')).toMatch(/does not print a statement column header/);
    expect(failures.join('\n')).toMatch(/does not print the page name/);
    expect(failures.join('\n')).toMatch(/does not print a glossary term/);
    expect(failures.join('\n')).toMatch(/does not print a panel title/);
  });
});
