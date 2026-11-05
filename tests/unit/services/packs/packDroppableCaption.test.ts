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

  it('is dropped when nothing else is left, the page fits, and the page says so', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const { page: fitted, dropped } = fitPageReport(subject);
      expect(fitted.blocks.some((b) => b.kind === 'narrative')).toBe(false);
      expect(dropped.captions).toBe(1);
      expect(dropped.footnotes).toBe(3);
      expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
      const said = fitted.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
      expect(said?.text).toContain('3 footnotes, 1 derived caption');
      expect(said?.text).toContain('Every figure, table and chart on the page is complete');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Income statement') && String(c[0]).includes('caption'))).toBe(true);
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
