/**
 * PAGE 5 CLAIMED THE TWELVE-MONTH WINDOW "IS THE SERIES PAGE 10 DRAWS", AND
 * TWO OF THE DEMO'S SIX PANELS DRAW THREE PERIODS OF IT.
 *
 * Gross margin and debtor days run Jul 2026 to Sep 2026 (part) because
 * revenue is nil before July and neither ratio is defined without it —
 * `ratioPanel` drops the months it cannot measure rather than plotting a
 * false zero, which is right, and which nothing in the demo pack stated.
 *
 * THE SAME SENTENCE IS TRUE IN THE BRIGHTSPHERE PACK, whose four drawn panels
 * are all twelve periods, and that asymmetry is why fourteen gates passed it.
 * Brightsphere also already carried the governing rule for the OTHER case —
 * "A panel is omitted when its figure is not meaningful in every period of
 * the window" — so one company had a rule for omission and the other had none
 * for shortening.
 *
 * These hold both halves, on both companies, and on the fixture that actually
 * reproduces the live demo's panel shape.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { buildTrendPanels } from '@/modules/accounting/services/packs/pages/packTrendCharts';
import {
  PANEL_OMITTED_RULE,
  SHORTENED_PANELS_HEADING,
  shortenedPanelsNote,
} from '@/modules/accounting/services/packs/pages/packShortenedPanels';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { brightsphereReceivablesGapInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput, liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

function windowNote(input: BoardPackInput): string {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Monthly results')!;
  for (const block of page.blocks) {
    if (block.kind !== 'disclosure') continue;
    const note = block.disclosure.notes.find((n) => n.heading === 'The window');
    if (note) return note.body;
  }
  throw new Error('page 5 carries no window note');
}

function ruleNote(input: BoardPackInput): string | null {
  const page = buildBoardPackPages(input).pages
    .find((p) => p.navLabel === 'Commentary and actions')!;
  for (const block of page.blocks) {
    if (block.kind !== 'disclosure') continue;
    if (block.disclosure.heading !== SHORTENED_PANELS_HEADING) continue;
    return block.disclosure.notes.map((n) => n.body).join(' ');
  }
  return null;
}

describe('page 5 does not claim page 10 draws a series it does not', () => {
  it('the demo pack really does shorten two of its six panels', () => {
    // The premise, asserted rather than assumed — and asserted on the fixture
    // that reproduces the live ledger, because the one that claims to be the
    // live render gives every month revenue and shortens nothing.
    const panels = buildTrendPanels(liveDemoShortPanelsInput.trend, PACK_SCALE);
    expect(panels.panels).toHaveLength(6);
    expect(panels.shortenedPanels).toEqual(['Gross margin', 'Debtor days']);
    expect(buildTrendPanels(liveDemoRenderedInput.trend, PACK_SCALE).shortenedPanels).toEqual([]);
  });

  it('says the window is what page 10 draws FROM, on both companies', () => {
    for (const input of [liveDemoShortPanelsInput, brightsphereReceivablesGapInput]) {
      const body = windowNote(input);
      expect(body).toMatch(/the window page 10 draws from/);
      // The claim that two shortened panels disprove.
      expect(body).not.toMatch(/which is the series page 10 draws/);
    }
  });
});

describe('a panel drawn over part of the window says why', () => {
  it('names the panels and states the rule, on the shape that has them', () => {
    const body = ruleNote(liveDemoShortPanelsInput);
    expect(body, 'the pack shortens two panels and never says so').not.toBeNull();
    expect(body).toContain('Gross margin');
    expect(body).toContain('Debtor days');
    expect(body).toMatch(/12 months/);
    expect(body).toMatch(/not measured in a month whose base is nil/);
    // And it states the OTHER half of the same rule, which is the half
    // Brightsphere prints on page 10 — so a reader meeting either behaviour
    // has both.
    expect(body).toContain(PANEL_OMITTED_RULE);
  });

  it('is silent where every drawn panel covers the whole window', () => {
    // Brightsphere draws four panels over twelve months and already carries
    // the omission rule on page 10; a note about shortening would name a
    // behaviour that pack does not exhibit.
    expect(ruleNote(brightsphereReceivablesGapInput)).toBeNull();
    expect(ruleNote(liveDemoRenderedInput)).toBeNull();
  });

  it('names no panel whose title says it covers the whole window', () => {
    // Read off the same `pick` the panels are drawn from, so the note cannot
    // name a twelve-period panel.
    const panels = buildTrendPanels(liveDemoShortPanelsInput.trend, PACK_SCALE);
    const body = ruleNote(liveDemoShortPanelsInput)!;
    for (const panel of panels.panels) {
      const name = panels.shortenedPanels.find((n) => panel.title.startsWith(n));
      if (name === undefined) continue;
      expect(panel.title, `${name} is named as shortened but its title says 12`)
        .not.toMatch(/over 12 periods/);
    }
    expect(body).not.toMatch(/Revenue|Operating expenses|Net profit|Cash/);
  });

  /**
   * ONE SHORTENED PANEL IS ONE PANEL, AND THE NOTE HAS FOUR AGREEMENTS IN IT.
   *
   * The only fixture with shortened panels shortens exactly two, so every
   * singular arm of this sentence was unreachable and forcing the plural was
   * green. A pack that shortens one — a company whose revenue starts mid-window
   * and whose debtor days are measurable throughout — would have printed
   * "Gross margin are drawn over fewer than the 12 months … those panels start
   * … each panel's own title states".
   */
  it('speaks in the singular where exactly one panel is shortened', () => {
    const body = shortenedPanelsNote(['Gross margin'], liveDemoShortPanelsInput.trend)!;
    const note = body.kind === 'disclosure' ? body.disclosure.notes[0]!.body : '';
    expect(note).toContain('Gross margin is drawn over fewer than the 12 months');
    expect(note).toContain('so that panel starts at the first month it can be measured');
    expect(note).toContain("its own title states how many periods it covers");
    // And none of the plural forms survives anywhere in the sentence.
    expect(note).not.toMatch(/are drawn over fewer|those panels start|they can be measured|each panel's own title/);
  });

  it('refuses to speak about a window it was not given', () => {
    expect(shortenedPanelsNote([], liveDemoShortPanelsInput.trend)).toBeNull();
    expect(shortenedPanelsNote(['Gross margin'], [])).toBeNull();
  });
});

/**
 * ONE RULE, ONE WORDING — AND THE LOOSE HALF READ AS ITS OWN OPPOSITE.
 *
 * Page 10 said "A panel is omitted when its figure is not meaningful in every
 * period of the window", which parses two ways: "not (meaningful in every
 * period)" is the demo's shortened gross-margin panel, and would have the
 * sentence contradict a panel three centimetres above it. Page 4's half said
 * it precisely. They are two halves of a single rule — omit where the measure
 * exists nowhere in the window, shorten where it exists in part of it — so
 * they are now ONE string, and neither sheet can drift from the other.
 */
describe('both halves of the panel rule are the same sentence', () => {
  const disclosures = (input: BoardPackInput): string => buildBoardPackPages(input).pages
    .flatMap((p) => p.blocks)
    .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
    .join(' ');

  it('states the omission rule with the negation on the quantifier, not the verb', () => {
    // The ambiguous form is the defect, so it is what the test forbids.
    for (const input of [liveDemoShortPanelsInput, brightsphereReceivablesGapInput]) {
      const prose = disclosures(input);
      expect(prose).not.toMatch(/not meaningful in every period/);
      expect(prose).toContain(PANEL_OMITTED_RULE);
    }
  });

  it('and the two sheets that state it cannot word it differently', () => {
    // Page 10 states it when a panel is ABSENT; page 4 when one starts LATE.
    // Brightsphere has the first, the demo the second, and neither pack
    // carries both — so the only thing holding the two wordings together is
    // that there is one wording.
    expect(disclosures(brightsphereReceivablesGapInput)).toContain(PANEL_OMITTED_RULE);
    expect(disclosures(liveDemoShortPanelsInput)).toContain(PANEL_OMITTED_RULE);
    expect(PANEL_OMITTED_RULE).toMatch(/meaningful in no period/);
  });
});
