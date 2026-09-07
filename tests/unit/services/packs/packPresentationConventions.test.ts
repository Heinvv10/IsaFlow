/**
 * THE CONVENTIONS A DIRECTOR READS THE PACK THROUGH, held on the COMPOSED
 * document rather than on the functions that write it.
 *
 * Each of these is a sentence or a number the ninth visual gate read off the
 * rendered sheets and rejected, and each is the kind of defect a unit test
 * on one builder cannot see: a day count printed at one precision on sheet 3
 * and another on sheet 10 is correct in both places and wrong in the pack.
 * So the assertions walk every string the document prints, on three
 * companies, and say what may not appear anywhere in it.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereInput, brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';
import type { PackPage, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

const PACKS: Array<[string, PackPagesDocument]> = [
  ['the live demo company', buildBoardPackPages(liveDemoInput)],
  ['the demo fixture', buildBoardPackPages(demoInput)],
  ['Brightsphere', buildBoardPackPages(brightsphereInput)],
];

/**
 * Every string a page prints, whatever block it came out of.
 *
 * Deliberately a blind walk rather than a per-kind reader: the point of
 * these conventions is that they hold EVERYWHERE, and a walk that enumerates
 * block kinds misses the one that has not been written yet. Rendered SVG is
 * skipped — it is markup, not prose, and its own text is asserted on the
 * printed sheet by `packTextLayer`.
 */
function stringsOn(page: PackPage): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.startsWith('<svg')) found.push(value);
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'svg' || key === 'sparklineSvg' || key === 'trendSvg' || key === 'bulletSvg') continue;
        walk(inner);
      }
    }
  };
  walk({ title: page.title, blocks: page.blocks, footnotes: page.footnotes });
  return found;
}

function stringsIn(doc: PackPagesDocument): string[] {
  return doc.pages.flatMap(stringsOn);
}

function pageNamed(doc: PackPagesDocument, navLabel: string): PackPage {
  const page = doc.pages.find((p) => p.navLabel === navLabel);
  if (page === undefined) throw new Error(`no ${navLabel} page`);
  return page;
}

/**
 * ONE DECIMAL RULE PER MEASURE, AND FOR A DAY COUNT IT IS NONE.
 *
 * Sheets 3 and 9 printed "213 days", "789 days" and "1 035 days"; sheet 10
 * printed "18.6 days" and "59.6 days", under the same label. The two ARE on
 * different bases and the pack discloses that on both pages — but precision
 * is not how a reader tells one basis from another, and a director reading
 * one figure to a tenth and another to the unit takes the first for the more
 * exact one.
 *
 * The mutation this goes red on is `formatDays(n, 1)` in the trend panel
 * spec, which is where the second precision came from.
 */
describe('day counts print at one precision throughout the pack', () => {
  for (const [company, doc] of PACKS) {
    it(`prints no fractional day count anywhere on ${company}`, () => {
      const fractional = stringsIn(doc).filter((text) => /\d[\d\s]*\.\d+\s+days\b/.test(text));
      expect(fractional, 'a day count to a decimal place, beside whole-day counts elsewhere')
        .toEqual([]);
    });
  }

  it('is not vacuous — the pack does print day counts', () => {
    const [, live] = PACKS[0]!;
    expect(stringsIn(live).some((text) => /\d[\d\s]*\s+days\b/.test(text))).toBe(true);
  });
});

/**
 * THE HEADLINE IS A FINDING ABOUT THE BUSINESS, NEVER A RENDERING STATUS.
 *
 * Sheet 10 ended its headline "; 6 of 6 panels are drawn." — four of the
 * pack's twelve titles narrated the generator rather than the period, and
 * this is the one that cannot appear on a document going to non-executive
 * directors. The count itself is not lost: the page's own caption opens "6
 * metrics are tracked over the period", and where a measure is MISSING the
 * mandatory `Panels not drawn` block names how many, which, and why.
 */
describe('no page title narrates the renderer', () => {
  for (const [company, doc] of PACKS) {
    it(`states a finding in every headline on ${company}`, () => {
      for (const page of doc.pages) {
        expect(page.title, `page ${page.number} reports how many panels rendered`)
          .not.toMatch(/panels are drawn/i);
      }
      // AND THE OTHER HALF OF THE SAME DEFECT: a headline whose subject is
      // the reason a ratio could not be formed rather than the figure it
      // could not be formed from. Sheets 3 and 4 both led with one, on a
      // page of real losses.
      //
      // SHEET 8 IS NOT ONE OF THEM, and the difference is what the sentence
      // does rather than what it says. "Cash stands at (531); the
      // comparative cash figure is negative, so the percentage change is not
      // meaningful." states the level FIRST and the clause completes it;
      // sheet 3 spent the whole first sentence on the denominator and sheet
      // 4 half of its only one.
      for (const navLabel of ['Highlights', 'Commentary and actions']) {
        expect(pageNamed(doc, navLabel).title, `${navLabel} leads with a missing denominator`)
          .not.toMatch(/no positive comparative base|percentage change is not meaningful/i);
      }
    });

    it(`keeps the panel count on the trends page where it is information on ${company}`, () => {
      const trends = pageNamed(doc, 'Trends');
      const text = stringsOn(trends).join('\n');
      // Either the caption's "N metrics are tracked", or — where a measure
      // could not be drawn — the block that names which and why.
      expect(text).toMatch(/metrics are tracked|could be drawn for this company/);
    });
  }
});

/**
 * AND THE CLAUSE THE HEADLINE GAVE UP IS STILL ON THE PAGE.
 *
 * Moving a disclosure out of a headline is only a fix if it lands somewhere.
 * Sheets 3 and 4 both carry a comparative that is not a usable base on the
 * live demo company, and both must still say so — under the rule, with the
 * rest of the page's apparatus.
 */
describe('the comparative-base disclosure survives the move off the headline', () => {
  const [, live] = PACKS[0]!;

  /**
   * IT IS ON THE TILE IT IS ABOUT, ANCHORED BY POSITION.
   *
   * It used to be page 3's footnote 2, with no superscript anywhere on the
   * sheet to attach it to, beside a footnote 1 correctly anchored to five
   * tiles — an orphan the tenth gate called conspicuous. The sentence was
   * already on the page: the revenue tile's own caption carries
   * `NOT_A_POSITIVE_BASE` in the same condition. This asserts the caption
   * states it and that the sheet no longer carries the loose second copy.
   */
  it('Highlights states on the revenue tile itself why no percentage change is shown', () => {
    const page = pageNamed(live, 'Highlights');
    const captions = page.blocks
      .filter((b) => b.kind === 'disclosure' && b.disclosure.heading === 'Commentary')
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []));
    const revenue = captions.find((n) => /^revenue$/i.test(n.heading));
    expect(revenue?.body, 'the revenue tile says nothing about its missing movement')
      .toMatch(/not a positive base/i);
    // And the loose second copy is gone: every footnote this sheet prints is
    // one a tile carries a superscript for.
    expect(page.footnotes.map((f) => f.number)).toEqual([1]);
  });

  /**
   * PAGE 4 CARRIES NO FOOTNOTE AT ALL NOW.
   *
   * `narrativeComparativeFootnote` explained why the headline's net-profit
   * percentage could not be formed, and the headline no longer states one —
   * it states what the page's own panel puts to the board. A footnote about a
   * sentence that is not on the sheet is the second unanchored footnote in
   * the pack.
   */
  it('Commentary and actions is titled by its payload, not by net profit', () => {
    const page = pageNamed(live, 'Commentary and actions');
    expect(page.title).toMatch(/matters requiring a board decision/i);
    expect(page.title).not.toMatch(/net profit/i);
    expect(page.footnotes).toEqual([]);
  });
});

/**
 * A METAPHOR MAY NOT COLLAPSE ON THE SHEET THAT NEEDS PRECISION MOST.
 *
 * Sheet 7's chart title read "Assets of (730) stand on liabilities of 3 357
 * and equity of (4 087)". Nothing stands on anything when the asset side is
 * negative, and both live companies print a negative component there.
 */
describe('the balance sheet chart claims no shape the figures do not have', () => {
  for (const [company, doc] of PACKS) {
    it(`states the identity plainly where a component is negative on ${company}`, () => {
      const position = pageNamed(doc, 'Balance sheet');
      const chart = position.blocks.find((b) => b.kind === 'chart');
      expect(chart?.kind).toBe('chart');
      const title = chart!.kind === 'chart' ? chart!.chart.title : '';
      if (/\(/.test(title)) {
        // A bracket in the title is this pack's negative, so the sentence
        // must not be the structural one.
        expect(title, 'a negative component under a structural verb').not.toMatch(/stand on/);
        expect(title).toMatch(/are matched by/);
      } else {
        expect(title).toMatch(/stand on/);
      }
    });
  }
});

/**
 * THE PACK STATES ITS PALETTE, AND ITS QUALIFICATIONS ARE READ BEFORE ITS
 * FIGURES.
 *
 * Three colour systems ran through the pack — income/cost/total on the
 * bridges, three neutral bands on the balance sheet, red for a missed target
 * on the scorecard — and the basis page defined none of them, so red meant a
 * cost on sheet 6 and a failure on sheet 9 with nothing connecting the two.
 * The room for saying so came from the caveats, which now print with the
 * contents: page 12 was composing within two millimetres of its box on a
 * live ledger, and page 2 was an index over 60% white.
 */
describe('the pack states one palette, and its caveats with the contents', () => {
  for (const [company, doc] of PACKS) {
    it(`defines every colour system on the basis page of ${company}`, () => {
      const key = stringsOn(pageNamed(doc, 'Basis of preparation')).join('\n');
      expect(key, 'the bridges').toMatch(/green is an income line, red a cost line/i);
      expect(key, 'the greyscale claim').toMatch(/lightness/i);
      expect(key, 'the balance sheet').toMatch(/balance sheet's bands/i);
      expect(key, 'the scorecard').toMatch(/scorecard marks a missed target/i);
    });

    it(`prints the caveats with the contents on ${company}, and counts them on the basis page`, () => {
      const contents = pageNamed(doc, 'Contents');
      const caveats = contents.blocks.find(
        (b) => b.kind === 'disclosure' && b.disclosure.heading === 'Caveats',
      );
      expect(caveats, 'the contents page carries no caveats').toBeDefined();
      const printed = caveats!.kind === 'disclosure' ? caveats!.disclosure.notes.length : 0;
      expect(printed).toBeGreaterThan(0);
      // REQUIRED, so the fitter reaches them last and never takes the first.
      expect(caveats!.kind === 'disclosure' && caveats!.disclosure.required).toBe(true);

      // And the basis page counts what that page printed and says where —
      // except on a pack that has no caveat at all, where the "None" note
      // above is the whole of it and there is nothing to send a reader to.
      const basis = pageNamed(doc, 'Basis of preparation');
      const hasCaveats = doc.pages.some((p) => p.number === contents.number)
        && !/^No classification or inventory caveat/.test(
          caveats!.kind === 'disclosure' ? caveats!.disclosure.notes[0]!.body : '',
        );
      if (hasCaveats) {
        expect(basis.title).toContain('printed with the contents');
        expect(basis.title).toMatch(
          printed === 1 ? /one caveat qualifies/ : new RegExp(`${printed} caveats qualify`),
        );
      } else {
        expect(basis.title).toContain('no caveat qualifies these figures');
      }
      expect(
        basis.blocks.some((b) => b.kind === 'disclosure' && b.disclosure.heading === 'Caveats'),
        'the caveats print twice',
      ).toBe(false);
    });
  }
});


/**
 * THE HIGHLIGHTS PAGE IS THE ONE MOST OFTEN FORWARDED ON ITS OWN, AND IT SAID
 * NOTHING ABOUT THE PART MONTH.
 *
 * Every tile on sheet 3 — both margins, net profit, working capital, debtor
 * days — is measured over a period whose final month is a stub, and pages 5,
 * 8, 10 and 12 each say so about their own figures while this one did not.
 * It is a NOTE rather than a footnote: it is about every tile on the sheet
 * rather than one of them, and page 3 already carries an anchored footnote 1.
 *
 * Held on the COMPOSED page, so it also proves `fitPageToBox` did not pay for
 * the note by dropping it again.
 */
describe('the highlights page states its part month', () => {
  // BOTH LIVE PACKS, because they are the two that HAVE a part month. Until
  // this round no fixture in the suite carried one at all — `partial` was
  // simply absent from `liveDemoTrend` and `brightsphereLiveTrend`, so every
  // "(part)" marker the rendered packs print was invisible to the composer
  // tests, and a note added to sheet 3 could push the live sheet past its box
  // with the whole suite green. It did — and since task 36 corrected the
  // ruler, it does: the second test below is Brightsphere's sheet 3 losing
  // the note, recorded rather than skipped.

  it('the live demo company', () => {
    const page = pageNamed(PACKS[0]![1], 'Highlights');
    const said = stringsOn(page).join(' ');
    expect(said).toMatch(/Every tile covers the whole period, whose last month — \w+ \d+ — is \d+ of its \d+ days/);
    // AND IT DID NOT PAY FOR IT WITH ANOTHER NOTE. The first draft of this
    // note ran to two lines and the sheet dropped the Scale note to carry it.
    expect(page.footnotes.filter((f) => /Not printed on this page/.test(f.text))).toEqual([]);
    expect(said).toMatch(/Figures are in R'000/);
  });

  /**
   * AND LIVE BRIGHTSPHERE'S SHEET 3 NO LONGER CARRIES EITHER — which is a
   * measured loss, recorded here rather than quietly dropped.
   *
   * This sheet composed at 98.7% of its box under a ruler that read the
   * pack's own prose 7 to 12 per cent short. `WIDTH_SAFETY` is now 1.12,
   * above the worst string these fixtures print (task 36), and the sheet is
   * 4.2mm over: the trimmer takes the last two notes of "Reading these
   * tiles", which are the part-month sentence and the one stating the scale
   * the tiles are in. The sheet says on its face that it did.
   *
   * That is a decision about what sheet 3 prints and it is open — see task
   * 36's fix report. It is asserted rather than skipped so it cannot become
   * permanent by nobody looking, and so it goes RED the day sheet 3 is
   * shortened enough to carry both notes again.
   */
  it('live Brightsphere states the loss on the sheet, pending the decision', () => {
    const page = pageNamed(buildBoardPackPages(brightsphereLiveInput), 'Highlights');
    const said = stringsOn(page).join(' ');
    expect(said).not.toMatch(/Every tile covers the whole period, whose last month/);
    expect(said).not.toMatch(/Figures are in R'000/);
    // The sheet does not lose them silently: it names the disclosure it took
    // them from, in a footnote a director reads.
    expect(page.footnotes.map((f) => f.text).join(' '))
      .toMatch(/Not printed on this page: 2 explanatory notes, from “Reading these tiles”/);
  });

  it('says nothing where the period ends on a whole month', () => {
    // The negative pin: `demoInput`'s series is twelve whole months, and a
    // pack that invented a part-month statement would be worse than silent.
    const page = pageNamed(PACKS[1]![1], 'Highlights');
    expect(stringsOn(page).join(' ')).not.toMatch(/part month/i);
  });
});

/**
 * THE FOURTH NOTATION, DECLARED.
 *
 * The basis page defined brackets, the dash and `n/m`, and the statements
 * print a fourth — `<1`, in brackets where negative — for a real amount that
 * rounds to nothing at the stated scale. It sat on sheet 6 beside a dash
 * convention that means the opposite.
 */
describe('every notation the pack prints is declared on the basis page', () => {
  for (const [name, doc] of PACKS) {
    it(`${name}`, () => {
      const basis = stringsIn(doc).join('\n');
      // The declaration is unconditional — a basis of preparation that
      // changed shape with the month is not a basis of preparation — so this
      // holds whether or not this company's figures reach the notation.
      expect(basis).toMatch(/too small to show at this scale prints as <1/);
      // And it survives the fitter: page 12 composes within 2mm of its box on
      // live Brightsphere, so a definition that is dropped is a notation the
      // pack prints and does not declare.
      const page = doc.pages[doc.pages.length - 1]!;
      expect(stringsOn(page).join(' ')).toMatch(/prints as <1, or \(<1\) where it is negative/);
    });
  }
});
