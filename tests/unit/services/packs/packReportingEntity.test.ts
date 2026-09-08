/**
 * THE PACK SAYS WHAT ENTITY IT REPORTS ON, AND DOES NOT CLAIM A BOUNDARY IT
 * CANNOT SUPPORT.
 *
 * The thirty-first blind visual gate failed criterion 11 — basis of
 * preparation complete — on both companies, for one defect with two halves.
 * Sheet 5 was headed `GROUP RESULTS` and listed as "5 Group results" in the
 * contents; the word appeared exactly twice per document and was defined
 * nowhere. Page 12 named a standard, a period, a comparative period, a
 * currency, a rounding rule, a source system, an extraction time and a ledger
 * version — and never the reporting entity or a consolidation basis. So the
 * pack asserted a group in a header over a basis page that neither confirmed
 * nor denied one: on a single `(Pty) Ltd` that overstates the boundary, and
 * on a real group it is a consolidation policy that was never stated.
 *
 * Both halves are held here, and they are held SEPARATELY on purpose.
 * Renaming the sheet (`MONTHLY_RESULTS_NAV_LABEL`) removes the assertion; it
 * does not make the basis complete, because a basis of preparation that never
 * says what entity it reports on is incomplete whatever the sheets are
 * called. A test for only the name would go green on a pack that still cannot
 * say whose figures these are.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  brightsphereInput,
  demoInput,
  denseInput,
  noRatioPanelsInput,
} from './fixtures/boardPackInputs';
import { liveDemoBridgeInput, liveDemoInput } from './fixtures/liveDemoBoardPack';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

const FIXTURES: Record<string, BoardPackInput> = {
  demo: demoInput,
  brightsphere: brightsphereInput,
  dense: denseInput,
  'no ratio panels': noRatioPanelsInput,
  live: liveDemoInput,
  'live, with the EBITDA bridge that rounds': liveDemoBridgeInput,
};

/**
 * Every string the composed pages carry, EXCEPT the ones that are not prose.
 *
 * A recursive walk rather than a per-block-kind reader: the word this is
 * looking for reached paper through `navLabel`, which no prose collector in
 * this suite was reading, and the next one will reach it through whichever
 * field the next collector forgets. `svg` is excluded because a chart's
 * serialised SVG is markup and not something a reader reads as words, and
 * `kind` / `type` / `id` because those are the model's own vocabulary —
 * a zrender element is literally `{ type: 'group' }`, which is a fact about
 * the renderer and not a claim on the paper.
 */
function printedStrings(page: PackPage): string[] {
  const out: string[] = [];
  const skip = new Set(['svg', 'sparklineSvg', 'trendSvg', 'bulletSvg', 'kind', 'type', 'id']);
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (skip.has(key)) continue;
        walk(inner);
      }
    }
  };
  walk({ title: page.title, navLabel: page.navLabel, blocks: page.blocks, footnotes: page.footnotes });
  return out;
}

/** The `Reporting entity` fact off page 12, or null where it is not printed. */
function reportingEntity(pages: PackPage[]): string | null {
  const basis = pages.at(-1)!.blocks.find(
    (b) => b.kind === 'disclosure' && b.disclosure.heading === 'Basis of preparation',
  );
  if (basis?.kind !== 'disclosure') return null;
  return basis.disclosure.notes.find((n) => n.heading === 'Reporting entity')?.body ?? null;
}

describe('the basis of preparation names the entity it reports on', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`names ${name}'s company and states that nothing is consolidated into it`, () => {
      const fact = reportingEntity(buildBoardPackPages(input).pages);
      expect(fact, 'page 12 carries no Reporting entity fact at all').not.toBeNull();
      // The LEGAL name off the cover, not a display name or a slug: the fact
      // is only auditable if it is the same entity the cover claims.
      expect(fact, 'the fact does not name the company the cover names')
        .toContain(input.companyLegalName);
      // AND THE BASIS ITSELF. A name alone leaves the boundary question open,
      // which is the half of this defect that survived a rename.
      expect(fact!.toLowerCase(), 'the fact names an entity and states no consolidation basis')
        .toContain('not consolidated');
    });
  }

  /**
   * NOT VACUOUS. Every fixture must carry a company name for the assertion
   * above to be about anything — an empty `companyLegalName` makes
   * `toContain('')` true of any string in JavaScript.
   */
  it('is checking a real name on every fixture', () => {
    for (const [name, input] of Object.entries(FIXTURES)) {
      expect(input.companyLegalName.length, `${name} has no legal name`).toBeGreaterThan(3);
    }
  });
});

describe('no sheet asserts a group the basis does not define', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`prints no undefined group boundary on ${name}`, () => {
      const doc = buildBoardPackPages(input);
      const offenders = doc.pages.flatMap((page) => printedStrings(page)
        .filter((text) => /\bgroups?\b/i.test(text))
        .map((text) => `p${page.number} (${page.navLabel}): ${text}`));
      expect(offenders, 'the pack says "group" somewhere and page 12 states no consolidation basis')
        .toEqual([]);
    });
  }

  /**
   * AND THE WALK REALLY REACHES THE PLACE THE WORD WAS.
   *
   * `navLabel` is where "Group results" printed — in the running footer, and
   * in the contents index built from it — and no existing prose collector in
   * this suite read it. If `printedStrings` ever stops seeing it, the tests
   * above go green on the exact document the gate failed.
   */
  it('reads the page label, which is where the word was', () => {
    const page = buildBoardPackPages(demoInput).pages.find((p) => p.number === 5)!;
    expect(page.navLabel).toBe('Monthly results');
    expect(printedStrings(page)).toContain('Monthly results');
  });
});
