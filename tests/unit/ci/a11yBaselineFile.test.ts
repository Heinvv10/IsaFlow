// Guards on the committed baseline itself (tests/e2e/golden-paths/a11y-baseline.json): it may only shrink, so
// nothing in it may be loose enough to excuse a violation nobody recorded.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { A11Y_SCREENS, A11Y_SHELL_KEYS } from '../../e2e/golden-paths/helpers/a11yScreens';
import { pageKeyOf, type BaselineFile } from '../../e2e/golden-paths/helpers/a11yBaseline';

const ROOT = path.join(__dirname, '../../..');
const baseline = JSON.parse(readFileSync(path.join(ROOT, 'tests/e2e/golden-paths/a11y-baseline.json'), 'utf8')) as BaselineFile;
const entries = Object.entries(baseline.pages).flatMap(([page, list]) => list.map((e) => ({ page, ...e })));
// Rules about the whole document: the element IS `html`.
const DOCUMENT_RULES = new Set(['document-title', 'html-has-lang', 'html-lang-valid']);

function routeExists(route: string): boolean {
  const base = path.join(ROOT, 'pages', route);
  return existsSync(`${base}.ts`) || existsSync(path.join(base, 'index.ts'));
}

describe('a11y-baseline.json', () => {
  it('has an entry per page that is a scanned screen (or its #rows table, or a shell piece): nothing baselined is unscanned', () => {
    const scanned = new Set<string>(Object.values(A11Y_SHELL_KEYS));
    for (const s of A11Y_SCREENS) {
      const key = pageKeyOf(`http://x${s.path}`);
      scanned.add(key);
      if (s.rowsTable) scanned.add(`${key}#rows`);
    }
    expect(Object.keys(baseline.pages).filter((p) => !scanned.has(p))).toEqual([]);
  });

  it('every scanned screen path is distinct, with a heading', () => {
    const paths = A11Y_SCREENS.map((s) => s.path);
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

  describe('dataDriven entries, which excuse any count up to their cap and are never stale', () => {
    const driven = entries.filter((e) => e.dataDriven !== undefined);

    it('name the API route whose data decides them (a route that exists) and say why', () => {
      expect(driven.length).toBeGreaterThan(0);
      for (const e of driven) {
        const where = `${e.page}: ${e.selector}`;
        expect(e.dataDriven!.source, where).toMatch(/^\/api\/[a-z0-9/-]+$/);
        expect(routeExists(e.dataDriven!.source.slice(1)), `${where}: ${e.dataDriven!.source} is not a route`).toBe(true);
        expect(e.dataDriven!.why.length, `${where} needs a reason`).toBeGreaterThanOrEqual(20);
      }
    });

    it('are anchored on a data-testid, a stable id or an aria-label: never a stack of bare tags', () => {
      for (const e of driven) {
        expect(/\[data-testid="[\w-]+"\]|#[A-Za-z][\w-]*|\[aria-label="[^"]+"\]/.test(e.selector), `${e.page}: ${e.selector}`).toBe(true);
      }
    });

    it('every one carries a hard cap taken from what the page can render (page size, list limit, box count)', () => {
      for (const e of driven) {
        expect(Number.isInteger(e.maxHint) && e.maxHint! >= 1, `${e.page}: ${e.selector} needs a maxHint`).toBe(true);
      }
    });

    it('a maxHint is only ever on a dataDriven entry', () => {
      for (const e of entries.filter((x) => x.maxHint !== undefined)) expect(e.dataDriven, `${e.page}: ${e.selector}`).toBeDefined();
    });
  });

  it('the Setup-guide button is in no page: it has its own test and key', () => {
    expect(entries.filter((e) => e.selector.includes('Setup guide') && !e.page.startsWith('shell:'))).toEqual([]);
  });
});
