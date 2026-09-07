/**
 * THE GATE THAT CAN SEE A BLANK PACK.
 *
 * Both fixtures are real `pdftotext -layout` output from the same code, the
 * same company and the same period, rendered minutes apart. The only
 * difference is that one render's font files were held back for nine seconds:
 * `renderedPack-fontsLoaded.txt` is 19 392 bytes and
 * `renderedPack-fontsBlocked.txt` is 746 — twelve well-formed sheets with
 * almost nothing on them, which is the artefact every other gate in this
 * repository passed.
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

  it('fails the render whose fonts did not', () => {
    const failures = checkPackTextLayer(doc, fixture('renderedPack-fontsBlocked.txt'));
    expect(failures.length).toBeGreaterThan(20);
    expect(failures.join('\n')).toMatch(/does not print a statement column header/);
    expect(failures.join('\n')).toMatch(/does not print the page name/);
    expect(failures.join('\n')).toMatch(/does not print a glossary term/);
    expect(failures.join('\n')).toMatch(/does not print a panel title/);
  });
});
