/**
 * THE LAST LEVER: A DERIVED CAPTION THAT ONLY RESTATES THE TABLE BESIDE IT MAY GO.
 *
 * Page 6 with net-debit revenue and a material interest/tax step carries two required
 * disclosures, the table's not-meaningful reasons and the sign-flip footnote, with the bridge
 * already at its 48mm floor and every optional note and footnote taken: 261 to 266mm in a 255mm
 * box, and the whole pack was refused. The one block left that the pack is not bound to make is the
 * one-line "largest mover" caption, which restates a row of the table above it.
 *
 * Pulled only when nothing else is left, so a page that fits today is never changed by it; the page
 * says so in its omission footnote; a caption that is not flagged (page 3's, an approved
 * commentary) is never touched.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { fitPageReport, OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import type { PackPage, PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';

const SENTENCE =
  'The prior column is the comparative period the basis page states, and a movement is never '
  + 'shown as a move from zero where that period carries no value for the measure.';
const CAPTION = 'Revenue moved the most in money, down 450.';

const required = (sentences: number): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: { heading: 'Lines below zero', required: true, notes: [{ heading: 'What this means', body: SENTENCE.repeat(sentences) }] },
});
const caption = (extra: Record<string, unknown> = {}): PackPageBlock =>
  ({ kind: 'narrative', narrative: { status: 'derived', body: CAPTION, actions: [] }, ...extra }) as PackPageBlock;

/** Three ordinary footnotes: the fitter takes these before it reaches a caption, and the omission note they buy is why a caption can pay at all. */
const page = (blocks: PackPageBlock[]): Omit<PackPage, 'number'> => ({
  title: 'Revenue is below zero.', navLabel: 'Income statement', section: 'Financials', orientation: 'portrait', density: 'high',
  blocks, footnotes: [1, 2, 3].map((number) => ({ number, text: SENTENCE })),
});

describe('a droppable caption', () => {
  // 27 sentences: 275.6mm as composed, 246.4mm once the footnotes and the caption are gone.
  const subject = page([required(27), caption({ droppable: true })]);

  it('is the fixture: footnotes alone cannot pay for it, so the page is refused without the flag', () => {
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));
    expect(() => fitPageReport(page([required(27), caption()]))).toThrow(PackRefusal);
  });

  it('is dropped when nothing else is left, the page fits, and the page says so (without logging)', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const { page: fitted, dropped } = fitPageReport(subject);
      expect(fitted.blocks.some((b) => b.kind === 'narrative')).toBe(false);
      expect(dropped.captions).toBe(1);
      expect(dropped.footnotes).toBe(3);
      expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
      const said = fitted.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
      expect(said?.text).toContain('3 footnotes; 1 derived caption');
      expect(said?.text).toContain('Every figure, table and chart on the page is complete');
      // The fit does not log: it is also run as a probe whose page is thrown away. The caller logs the page it uses.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('is kept while the footnotes can pay instead (it is the LAST lever)', () => {
    // 25 sentences: two footnotes pay and the caption stays.
    const { page: fitted, dropped } = fitPageReport(page([required(25), caption({ droppable: true })]));
    expect(dropped.captions).toBe(0);
    expect(dropped.footnotes).toBeGreaterThan(0);
    expect(fitted.blocks.some((b) => b.kind === 'narrative')).toBe(true);
  });

  it('is not dropped when it would not make the page fit: the page is still refused', () => {
    expect(() => fitPageReport(page([required(29), caption({ droppable: true })]))).toThrow(PackRefusal);
  });

  it('a page that fits keeps its caption and is returned unchanged', () => {
    const fits = page([required(10), caption({ droppable: true })]);
    const out = fitPageReport(fits);
    expect(out.page).toBe(fits);
    expect(out.dropped.captions).toBe(0);
  });
});

describe('a droppable caption on a page with no footnote to take first', () => {
  // A caption long enough that dropping it pays for the omission note on its own.
  const longCaption = (): PackPageBlock =>
    ({ kind: 'narrative', droppable: true, narrative: { status: 'derived', body: SENTENCE.repeat(3), actions: [] } }) as PackPageBlock;
  const bare = (blocks: PackPageBlock[]): Omit<PackPage, 'number'> => ({ ...page(blocks), footnotes: [] });

  it('is dropped, and the page owns the omission even though it had no footnote or note to lose', () => {
    const subject = bare([required(24), longCaption()]);
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));
    const { page: fitted, dropped } = fitPageReport(subject);
    expect(dropped).toMatchObject({ captions: 1, footnotes: 0, notes: 0, requiredNotes: 0 });
    expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
    expect(fitted.footnotes.map((f) => f.text).join(' ')).toContain('1 derived caption');
  });
});

describe('the omission note when a caption and a note tail go together', () => {
  it('attaches the disclosure heading to the notes and leaves the caption unattributed', () => {
    const subject = {
      ...page([
        { kind: 'disclosure', disclosure: { heading: 'Commentary', notes: Array.from({ length: 3 }, (unused, i) => ({ heading: `N${i}`, body: SENTENCE })) } },
        required(26), caption({ droppable: true }),
      ]),
      footnotes: [],
    };
    const { page: fitted, dropped } = fitPageReport(subject);
    expect(dropped.notes).toBeGreaterThan(0);
    expect(dropped.captions).toBe(1);
    const text = fitted.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))!.text;
    expect(text).toMatch(/^Not printed on this page: \d explanatory notes?, from \u201cCommentary\u201d; 1 derived caption\./);
  });
});
