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
