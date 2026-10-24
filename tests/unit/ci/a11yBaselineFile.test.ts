// Guards on the committed baseline itself (tests/e2e/golden-paths/a11y-baseline.json): it may only shrink, so
// nothing in it may be loose enough to excuse a violation nobody recorded.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_A11Y_SCREENS, A11Y_SCREENS } from '../../e2e/golden-paths/helpers/a11yScreens';
import { pageKeyOf, type BaselineFile } from '../../e2e/golden-paths/helpers/a11yBaseline';

const baseline = JSON.parse(readFileSync(path.join(__dirname, '../../e2e/golden-paths/a11y-baseline.json'), 'utf8')) as BaselineFile;
const entries = Object.entries(baseline.pages).flatMap(([page, list]) => list.map((e) => ({ page, ...e })));
// Rules about the whole document: the element IS `html`.
const DOCUMENT_RULES = new Set(['document-title', 'html-has-lang', 'html-lang-valid']);

describe('a11y-baseline.json', () => {
  it('has an entry per page that is a scanned screen: no page is baselined that nothing scans', () => {
    const scanned = new Set(ALL_A11Y_SCREENS.map((s) => pageKeyOf(`http://x${s.path}`)));
    expect(Object.keys(baseline.pages).filter((p) => !scanned.has(p))).toEqual([]);
  });

  it('every scanned screen path is distinct, with a heading', () => {
    const paths = ALL_A11Y_SCREENS.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const s of A11Y_SCREENS) expect(s.heading.length, s.name).toBeGreaterThan(0);
  });

  it('gives every entry a rule and a max of at least 1, once per page', () => {
    for (const e of entries) {
      expect(e.rule, e.page).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(Number.isInteger(e.max) && e.max >= 1, `${e.page} ${e.rule} ${e.selector}`).toBe(true);
    }
    const ids = entries.map((e) => `${e.page}|${e.rule}|${e.selector}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no bare tag, class, positional or generated-id selector', () => {
    for (const e of entries) {
      const where = `${e.page}: ${e.rule} ${e.selector}`;
      if (e.selector === 'html') { expect(DOCUMENT_RULES.has(e.rule), where).toBe(true); continue; }
      expect(e.selector, where).not.toMatch(/(^|[\s>])\.[\w\\-]/);        // a class selector
      expect(e.selector, where).not.toMatch(/\[class|nth-|:r[0-9a-z]+:/); // class attr, :nth-*, React ids
      const hasContext = e.selector.includes(' > ') || /#[A-Za-z]/.test(e.selector) || e.selector.includes('[data-testid');
      expect(hasContext, `${where} - a selector needs an ancestor or a stable id`).toBe(true);
    }
  });

  it('marks perRow only on selectors inside a table row or list item', () => {
    for (const e of entries.filter((x) => x.perRow)) {
      expect(/tbody > |li > /.test(e.selector), `${e.page}: ${e.selector}`).toBe(true);
    }
  });
});
