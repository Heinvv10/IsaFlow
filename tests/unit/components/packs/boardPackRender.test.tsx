/**
 * The twelve-page board pack, RENDERED — the first test in this workstream
 * that puts a composed `PackPagesDocument` through the actual components.
 *
 * It drives the same two fixtures the composer test does
 * (tests/unit/services/packs/fixtures/boardPackInputs.ts) rather than a
 * hand-built document: a fixture written for the renderer would be written to
 * the shape the renderer already handles, which is how a suite ends up green
 * against a pack nothing composes.
 *
 * WHAT EACH FIXTURE CANNOT REACH, since that is what decides the assertions:
 *   - `demoInput` has APPROVED commentary on pages 4 and 11, so on its own it
 *     can never show what a draft or a derived narrative does. Draft
 *     suppression and the derived label therefore get their own documents.
 *   - `brightsphereInput` has NO commentary at all (both pages pending), no
 *     prior, no budget and no trend — it is the only fixture that reaches the
 *     pending placeholder and the empty-page risk.
 *   - Neither fixture can reach the unknown-scale refusal, because
 *     `buildBasis` always states R'000. That branch is driven by overriding
 *     the composed document's own convention.
 */
import { describe, expect, it } from 'vitest';
import { act, render, within } from '@testing-library/react';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { PackBlockView } from '@/components/accounting/packs/pages/PackBlocks';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  brightsphereInput,
  demoInput,
} from '../../services/packs/fixtures/boardPackInputs';
import { liveDemoInput } from '../../services/packs/fixtures/liveDemoBoardPack';

const demoDoc = () => buildBoardPackPages(demoInput);

describe('board pack, rendered', () => {
  it('renders twelve pages and becomes print-ready', async () => {
    const { container } = render(<PackPagesView document={demoDoc()} />);
    // The gate waits for the pack's font faces too — a microtask, even under
    // happy-dom, which has no font-loading API to ask.
    await act(async () => {});
    expect(container.querySelectorAll('.pack-page')).toHaveLength(12);
    expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull();
  });

  it('renders an <svg> for every chart block the model declares', () => {
    const doc = demoDoc();
    // Panels are counted one by one, not one per block: `usePrintReady` waits
    // on `countPageModelCharts`, which does the same, so a small-multiples
    // page that drew one panel of six would otherwise read as satisfied.
    const declared = doc.pages.flatMap((p) => p.blocks).reduce((total, block) => {
      if (block.kind === 'chart') return total + 1;
      if (block.kind === 'smallMultiples') return total + block.panels.length;
      return total;
    }, 0);
    expect(declared).toBeGreaterThan(0);

    const { container } = render(<PackPagesView document={doc} />);
    expect(container.querySelectorAll('[data-pack-chart] svg').length).toBe(declared);
  });

  it('renders the Brightsphere shape without a zero column or an empty page', () => {
    const doc = buildBoardPackPages(brightsphereInput);
    const { container } = render(<PackPagesView document={doc} />);
    const pages = container.querySelectorAll('.pack-page');
    // ELEVEN for this company: with nothing approved there is no narrative
    // page, and its placeholder merges onto page 3 rather than shipping alone
    // (spec §5.7). Read off the document rather than hard-coded, so this
    // stays an assertion about the RENDERER and not about the page count.
    expect(pages).toHaveLength(doc.pages.length);
    for (const page of pages) {
      expect(page.textContent?.trim().length ?? 0, page.id).toBeGreaterThan(80);
    }
  });

  it('turns no sheet sideways — every page is portrait', () => {
    // Page 10 was the one landscape sheet, for six trend panels three across.
    // Printed and bound it was the sheet a director had to turn. The panels
    // are two across at 83mm now, which fits the portrait measure and gives
    // each panel 48mm rather than 36. The renderer's landscape path is still
    // live and still tested — `packPagesView.test.tsx` builds a landscape
    // page and asserts the attribute; no page in the board pack asks for it.
    const { container } = render(<PackPagesView document={demoDoc()} />);
    expect(container.querySelectorAll('[data-print-landscape]')).toHaveLength(0);
  });
});

describe('board pack commentary, R7', () => {
  /** `demoInput` with page 4's commentary replaced. */
  const withCommentary = (commentary: (typeof demoInput)['commentary']) =>
    buildBoardPackPages({ ...demoInput, commentary });

  it('keeps a DRAFT narrative body out of the DOM entirely, not merely hidden', () => {
    const doc = withCommentary({
      status: 'draft',
      body: 'UNAPPROVED-MODEL-SENTENCE',
      actions: ['UNAPPROVED-MODEL-ACTION'],
    });
    const { container } = render(<PackPagesView document={doc} />);

    // Not `toBeVisible`: a hidden node is still a node, and a stylesheet edit
    // or a "print backgrounds" setting brings it back. The text must not be
    // in the markup at all.
    expect(container.innerHTML).not.toContain('UNAPPROVED-MODEL-SENTENCE');
    expect(container.innerHTML).not.toContain('UNAPPROVED-MODEL-ACTION');
    // And the page did not silently vanish with it.
    expect(container.querySelectorAll('.pack-page')).toHaveLength(12);
  });

  it('renders an APPROVED narrative body and its actions', () => {
    const doc = withCommentary({
      status: 'approved',
      body: 'APPROVED-SENTENCE',
      actions: ['APPROVED-ACTION'],
    });
    const { container } = render(<PackPagesView document={doc} />);
    const page4 = container.querySelector('#pack-page-4')!;
    expect(page4.textContent).toContain('APPROVED-SENTENCE');
    expect(page4.textContent).toContain('APPROVED-ACTION');
  });

  it('labels a DERIVED caption apart from an approved one, in text and not only in colour', () => {
    // Page 4 is human-approved; page 5's caption is derived (`commentary()`
    // in packPageBlocks.ts). A reader of the printed page must be able to
    // tell which is which — R7 admits derived text because it is
    // deterministic, not because anyone signed it.
    const { container } = render(<PackPagesView document={demoDoc()} />);
    const page4El = container.querySelector('#pack-page-4') as HTMLElement;
    const page5 = within(container.querySelector('#pack-page-5') as HTMLElement);

    // Page 4 carries BOTH labels, on different columns, and that is the
    // point of §4.A's two-column layout: the commentary is signed and the
    // action panel beside it is machine-written from the matters. What R7
    // requires is that a reader can tell them apart, so the assertion is
    // about which COLUMN each label sits on, not about one being absent.
    const body = page4El.querySelector('.pack-narrative-body') as HTMLElement;
    const panel = page4El.querySelector('.pack-narrative-actions') as HTMLElement;
    expect(within(body).getByText(/Approved commentary/)).toBeInTheDocument();
    expect(within(body).queryByText(/Derived from the figures/)).toBeNull();
    expect(within(panel).getByText(/Derived from the figures/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Approved commentary/)).toBeNull();

    expect(page5.getByText(/Derived from the figures/)).toBeInTheDocument();
    expect(page5.queryByText(/Approved commentary/)).toBeNull();
  });

  it('shows the pending placeholder, and no body, where nothing has been approved', () => {
    const { container } = render(<PackPagesView document={buildBoardPackPages(brightsphereInput)} />);
    // On whichever page carries it. With nothing approved there is no
    // narrative page: the placeholder merges onto page 3 rather than shipping
    // alone on a sheet at 1.0% fill (spec §5.7). It still says the same
    // thing, which is what this test is about.
    const pages = [...container.querySelectorAll('.pack-page')]
      .filter((p) => (p.textContent ?? '').includes('Commentary pending approval'));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.querySelector('.pack-narrative-body'), page.id).toBeNull();
    }
  });
});

describe('board pack page 11, the matters table', () => {
  it('renders all five spec §4.A columns and a matter in every one of them', () => {
    const { container } = render(<PackPagesView document={demoDoc()} />);
    const table = container.querySelector('#pack-page-11 .pack-matters') as HTMLElement;
    expect(table).not.toBeNull();

    const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    // The quantum column names its SCALE. `ComparativeTable` states it above
    // its own figure columns and this table stated it nowhere, so a quantum of
    // `245` sat on a page with no unit anywhere near it.
    expect(headers).toEqual(["Issue", "Quantum (R'000)", 'Owner', 'Movement', 'Decision required']);

    const cells = [...table.querySelectorAll('tbody tr')[0]!.querySelectorAll('td')]
      .map((td) => td.textContent ?? '');
    expect(cells).toHaveLength(5);
    const matter = demoInput.matters[0]!;
    expect(cells[0]).toBe(matter.issue);
    // R'000, the document's own scale — not the raw 244 800.
    expect(cells[1]).toBe('245');
    expect(cells[2]).toBe(matter.owner);
    expect(cells[3]).toBe(matter.movement);
    expect(cells[4]).toBe(matter.decisionRequired);
  });

  /**
   * It printed "Not tracked — no prior board pack is stored to compare
   * against. — the same for every matter listed above." A full stop and an em
   * dash, because the joiner assumed a fragment and every value the pack
   * actually produces is a sentence.
   */
  it('joins the uniform-column note to a value that already ends a sentence', async () => {
    // The live fixture, not `demoInput`: a uniform-column note only appears
    // where several matters share a value, and the demo pack carries one.
    const { container } = render(<PackPagesView document={buildBoardPackPages(liveDemoInput)} />);
    await act(async () => {});
    // SCOPED TO THE COLLAPSED-COLUMN LIST. Page 11 now renders a SECOND
    // `.pack-table-notes` list — the lettered reason under the QUANTUM
    // column's `n/m`, which was the one not-meaningful figure in the pack
    // that carried none. That list is a different thing and reads "n/m —
    // <reason>", so the uniform-column assertion below is taken on the notes
    // that actually collapse a column.
    const notes = [...container.querySelectorAll('#pack-page-11 .pack-table-notes dd')]
      .map((dd) => dd.textContent ?? '')
      .filter((text) => !text.startsWith('n/m —'));

    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note).not.toMatch(/[.!?]\s*—/);
      expect(note).toContain('The same for every matter listed above.');
    }
  });

  it('prints n/m, never a dash and never a zero, for a matter with no single amount', () => {
    // Brightsphere's only matter is the explicit "no matters" item, whose
    // quantum is null. "R0" would say the exposure was measured at nothing —
    // and so, now, does a dash: `formatMoney` prints a measured zero as an en
    // dash and page 12 states that, so the one glyph cannot also mean "there
    // is no amount".
    const { container } = render(<PackPagesView document={buildBoardPackPages(brightsphereInput)} />);
    const cells = [...container.querySelectorAll('.pack-matters tbody td')]
      .map((td) => td.textContent);
    // `n/m` FOLLOWED BY ITS LETTERED MARK. The cell used to read a bare
    // `n/m`, which is the pack's convention broken in the one place it was
    // broken: every other not-meaningful figure carries a superscript to its
    // reason. `startsWith` rather than equality, because the mark is the
    // point.
    expect(cells[1]).toMatch(/^n\/m[a-z]?$/);
  });
});

describe('board pack figures, R-P52', () => {
  it('formats every money cell at the DOCUMENT scale, not at raw rands', () => {
    const doc = demoDoc();
    expect(doc.numberConvention.scale).toBe("R'000");
    const { container } = render(<PackPagesView document={doc} />);
    // PAGE 6. Page 5's table is months now, and its revenue column is the
    // monthly series rather than the period's 4 200 000 — see
    // `packMonthlyResults.ts`. The income statement is where the period's
    // revenue is a cell.
    const page6 = container.querySelector('#pack-page-6')!;

    // Revenue is 4 200 000 in the ledger. Under R'000 the cell reads 4 200,
    // and the caption above it says so. Scoped to the TABLE, not the page:
    // a derived title quotes figures in full rands as prose, which is a
    // separate house-style question already deferred to the visual gate.
    const table = page6.querySelector('.pack-table') as HTMLElement;
    expect(table.querySelector('caption')?.textContent).toBe("R'000");
    expect(table.textContent).toContain('4\u00a0200');
    expect(table.textContent).not.toContain('4\u00a0200\u00a0000');
  });

  it('changes what every cell prints when the document changes its scale', () => {
    // The pair is what proves the scale is WIRED rather than coincidental: a
    // renderer with a hardcoded R'000 would pass the assertion above and fail
    // this one.
    const doc = buildBoardPackPages(demoInput);
    const { container } = render(
      <PackPagesView document={{ ...doc, numberConvention: { scale: 'R', currency: 'ZAR' } }} />,
    );
    const table = container.querySelector('#pack-page-6 .pack-table') as HTMLElement;
    expect(table.textContent).toContain('4\u00a0200\u00a0000');
  });

  it('refuses to print at a scale no formatter knows, rather than printing unscaled', () => {
    const doc = buildBoardPackPages(demoInput);
    expect(() => render(
      <PackPagesView document={{ ...doc, numberConvention: { scale: 'thousands', currency: 'ZAR' } }} />,
    )).toThrow(/not a scale any formatter knows/);
  });
});

describe('the block kinds the board pack does not currently emit', () => {
  /**
   * `statTiles` is in the model and therefore in the dispatcher's exhaustive
   * switch, but no page of the BOARD pack carries one today — the management
   * pack's key-statistics strip (WS4c) is its first caller. Driving it from
   * a board pack document is impossible, so it is driven directly. Without
   * this the branch would ship untested and its first real use would be its
   * first render.
   */
  it('renders a stat-tile group at the document scale', () => {
    const { container } = render(
      <PackBlockView
        scale="R'000"
        block={{
          kind: 'statTiles',
          groups: [{
            heading: 'Key statistics',
            stats: [{
              label: 'Cash',
              figure: { value: 610_000, format: 'money', source: 'ledger', unavailable: null },
            }],
          }],
        }}
      />,
    );
    expect(container.querySelector('.pack-stat-group-heading')?.textContent).toBe('Key statistics');
    expect(container.querySelector('.pack-stat-label')?.textContent).toBe('Cash');
    expect(container.querySelector('.pack-stat-value')?.textContent).toBe('610');
  });
});

describe('board pack contents and cover', () => {
  it('indexes the pages by NAME, never by their conclusions', () => {
    // The rendered pack's contents read, in full: "4  Net profit of
    // (1 545 540); the comparative profit base is measured against a negative
    // comparative base, so the percentage change is not meaningful." A page
    // TITLE is a conclusion by rule (`assertPageTitleIsAMessage`), so an
    // index built from titles is built from the pack's own commentary, and a
    // director scanning for the balance sheet cannot find it.
    const doc = buildBoardPackPages(demoInput);
    const { container } = render(<PackPagesView document={doc} />);
    const entries = [...container.querySelectorAll('[data-pack-toc] .pack-contents-title')]
      .map((el) => el.textContent ?? '');

    expect(entries).toHaveLength(doc.pages.length);
    for (const entry of entries) {
      // A name, not a sentence: no terminal full stop, and short enough to
      // scan down a column.
      expect(entry, entry).not.toMatch(/\.$/);
      expect(entry.length, entry).toBeLessThan(40);
    }
    expect(entries).toContain('Balance sheet');
    expect(entries).toContain('Cash');

    // And no entry is a page title — the defect stated directly.
    for (const page of doc.pages) {
      if (page.title === page.navLabel) continue;
      expect(entries, `page ${page.number}`).not.toContain(page.title);
    }
  });

  it('puts the brand colour on the cover', () => {
    // The rendered cover had ZERO coloured pixels: the brand reached the rule
    // under every page title and the chart palette, and the one page a reader
    // sees first carried none of it. The band is a `::before` on `.pack-cover`
    // so it cannot be mistaken for content; what is asserted here is that the
    // cover carries the class the band is drawn on and that the document's
    // brand colour is declared for it.
    const doc = buildBoardPackPages(demoInput);
    const { container } = render(<PackPagesView document={doc} />);
    const cover = container.querySelector('[data-pack-cover]');
    expect(cover?.className).toContain('pack-cover');
    expect(container.querySelector('style')?.textContent).toContain(doc.brand.primaryColour);
  });
});
