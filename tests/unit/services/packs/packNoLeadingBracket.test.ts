/**
 * NO CLAUSE OPENS ON A BRACKETED FIGURE.
 *
 * The matters page read "…general ledger: 10 665 across 29 open documents
 * …, (2) across 14 open documents …" — a bracketed small negative at the
 * start of a clause reads as a list marker, item (2). The same shape was on
 * page 3's sparkline note: "share one y-scale, (5 535) to nil". A figure in
 * brackets is never the first thing in a clause of the pack's prose.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { receivablesReconciliationNote, type PackReceivablesRead } from '@/modules/accounting/services/packs/pages/packReceivablesReconciliation';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

/** A bracketed figure after the start of a sentence or a clause — a comma,
 *  a colon, a semicolon, or a conjunction ("…, and (5 535) at its furthest"). */
const LEADING = /(?:^|[:;,] |\b(?:and|or|but) )\(\d[\d\s]*\)/;

const item = (type: string, amount: number, documents: number) => ({
  bridge: 'subledger_to_control' as const, type, description: 'unused', amount,
  documentIds: Array.from({ length: documents }, (_unused, i) => `doc-${i}`), documentNumbers: [],
});

/** Every sentence a page prints: its title, notes, narrative, definitions and chart titles. */
function prose(page: PackPage): string[] {
  const out = [page.title, ...page.footnotes.map((f) => f.text)];
  for (const block of page.blocks) {
    if (block.kind === 'disclosure') for (const note of block.disclosure.notes) out.push(note.body);
    if (block.kind === 'narrative' && block.narrative.body !== null) out.push(block.narrative.body);
    if (block.kind === 'definitions') for (const entry of block.entries) out.push(entry.definition);
    if (block.kind === 'chart') out.push(block.chart.title);
    if (block.kind === 'smallMultiples') for (const panel of block.panels) out.push(panel.title);
  }
  return out;
}

describe('no clause opens on a bracketed figure', () => {
  it('the trends title names the furthest month without opening a clause on it', () => {
    const title = buildBoardPackPages(brightsphereLiveInput).pages.find((p) => p.navLabel === 'Trends')!.title.replace(/[\u00a0\u202f]/g, ' ');
    expect(title).toMatch(/reaches \(5 535\) at its furthest, in Apr 2026\.$/);
  });

  it('the receivables decomposition does not open a clause on a negative item\'s figure', () => {
    const read: PackReceivablesRead = {
      agedDebtorsTotal: 10_700_000,
      subledgerTotal: 10_724_260.43,
      controlBalance: 59_260.43,
      items: [item('document_not_linked_to_journal', 10_665_000, 29), item('posting_with_no_document', -2_000, 14), item('unapplied_receipt', 1_000, 3)],
      unexplained: 0,
    };
    const block = receivablesReconciliationNote(read, 59_260.43, PACK_SCALE);
    const body = block?.kind === 'disclosure' ? block.disclosure.notes[0]!.body.replace(/[  ]/g, ' ') : '';
    expect(body).toMatch(/a difference of \(2\) across 14 postings that reference no document/);
    expect(body).not.toMatch(LEADING);
  });

  it.each<[string, BoardPackInput]>([
    ['the demo company', demoInput],
    ['the live demo company, long window', liveDemoInput],
    ['the live demo company as it renders', liveDemoRenderedInput],
    ['Brightsphere', brightsphereLiveInput],
  ])('in any sentence of %s', (_name, input) => {
    const found = buildBoardPackPages(input).pages.flatMap((page) => prose(page)
      .map((s) => s.replace(/[  ]/g, ' '))
      .filter((s) => LEADING.test(s))
      .map((s) => `${page.navLabel}: ${s.slice(Math.max(0, s.search(LEADING) - 40), s.search(LEADING) + 40)}`));
    expect(found).toEqual([]);
  });
});
