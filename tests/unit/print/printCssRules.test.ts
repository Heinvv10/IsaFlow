// tests/unit/print/printCssRules.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'styles/packPrint.css'), 'utf8');

/** Strip comments so a rule mentioned in prose cannot satisfy an assertion.
 *  A test that greps source text is a linter unless it reads only real rules. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('pack print CSS', () => {
  it('forces exact colour rendering, prefixed and unprefixed', () => {
    expect(RULES).toMatch(/-webkit-print-color-adjust:\s*exact/);
    expect(RULES).toMatch(/(?<!-webkit-)print-color-adjust:\s*exact/);
  });

  it('repeats table headers across a page break', () => {
    expect(RULES).toMatch(/thead[\s\S]{0,120}display:\s*table-header-group/);
  });

  it('keeps a table row and a chart whole across a break', () => {
    expect(RULES).toMatch(/break-inside:\s*avoid/);
  });

  it('declares the A4 page box with no margin — the PDF transport owns the margin', () => {
    // preferCSSPageSize is never set in this repo, so Chromium ignores a CSS
    // @page margin and uses whatever the transport passes (PDF_MARGIN_MM in
    // src/lib/pdf/pdfTransport.ts). A margin declared here would be silently
    // ignored and would mislead the next reader into thinking it does something.
    const pageBlockMatch = RULES.match(/@page\s*\{([^}]*)\}/);
    expect(pageBlockMatch, '@page block must exist').not.toBeNull();
    const pageBlock = pageBlockMatch![1];
    expect(pageBlock).toMatch(/size:\s*A4/);
    expect(pageBlock).not.toMatch(/margin/);
  });
});

describe('pack print grid and scale', () => {
  const REQUIRED_CLASSES = [
    '.pack-page', '.pack-grid', '.pack-title', '.pack-section-heading',
    '.pack-table', '.pack-footnotes', '.pack-kpi-value',
  ];

  it('defines every class the page components rely on', () => {
    for (const cls of REQUIRED_CLASSES) {
      expect(RULES, cls).toContain(cls);
    }
  });

  it('uses a 12-column grid with an 8mm gutter', () => {
    expect(RULES).toMatch(/--pack-gutter:\s*8mm/);
    expect(RULES).toMatch(/grid-template-columns:\s*repeat\(12,/);
  });

  it('has no vertical table rules', () => {
    // IBCS: horizontal rules only. A border-left/right on a cell is the failure.
    expect(RULES).not.toMatch(/\.pack-table[^{]*\{[^}]*border-(left|right):/);
  });
});

/**
 * The page height and the PDF margin are two numbers in two files that must
 * add up. `.pack-page { min-height }` is what makes pack density measurable
 * rather than a matter of opinion — and it is A4's 297mm less the margin the
 * transport passes. Change PDF_MARGIN_MM alone and every pack silently gains
 * or loses page overflow, with no test to say so. Both numbers are parsed from
 * source here so neither can move without the other.
 */
describe('page height tracks the PDF margin', () => {
  const A4_HEIGHT_MM = 297;
  const TRANSPORT = readFileSync(join(process.cwd(), 'src/lib/pdf/pdfTransport.ts'), 'utf8');

  function marginMm(edge: 'top' | 'bottom'): number {
    const block = TRANSPORT.match(/PDF_MARGIN_MM\s*=\s*\{([^}]*)\}/);
    expect(block, 'PDF_MARGIN_MM must exist in src/lib/pdf/pdfTransport.ts').not.toBeNull();
    const found = block![1].match(new RegExp(`${edge}:\\s*(\\d+(?:\\.\\d+)?)`));
    expect(found, `PDF_MARGIN_MM.${edge} must be declared`).not.toBeNull();
    return Number(found![1]);
  }

  it('.pack-page min-height is A4 less the top and bottom margins', () => {
    const packPage = RULES.match(/\.pack-page\s*\{([^}]*)\}/);
    expect(packPage, '.pack-page rule must exist').not.toBeNull();
    const minHeight = packPage![1].match(/min-height:\s*(\d+(?:\.\d+)?)mm/);
    expect(minHeight, '.pack-page must set min-height in mm').not.toBeNull();

    expect(Number(minHeight![1])).toBe(A4_HEIGHT_MM - marginMm('top') - marginMm('bottom'));
  });
});
