/**
 * Every numbered superscript a pack page prints, and the footnote it resolves to.
 *
 * Shared by the fitter's anchor tests: the sweep over page 6's shapes and the unit tests over
 * hand-built pages. A location is a stable name for the row, column, note, tile or heading the
 * superscript sits on, so the same location can be found on a page before and after the fitter.
 */
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface Anchor { at: string; n: number }

/** The page's own footnote-bearing things, each as a location and the number it prints. */
export function anchorsOf(page: Pick<PackPage, 'blocks'>): Anchor[] {
  const out: Anchor[] = [];
  page.blocks.forEach((block, i) => {
    if (block.kind === 'disclosure') {
      for (const note of block.disclosure.notes) {
        if (note.footnote !== undefined) out.push({ at: `note ${block.disclosure.heading} / ${note.heading}`, n: note.footnote });
      }
    }
    if (block.kind === 'table') {
      const id = block.table.rows[0]?.key ?? block.table.rows[0]?.label ?? String(i);
      for (const r of block.table.rows) {
        if (r.footnote !== undefined) out.push({ at: `table ${id} row ${r.key ?? r.label}`, n: r.footnote });
      }
      for (const c of block.table.columnNotes ?? []) out.push({ at: `table ${id} column ${c.column}`, n: c.footnote });
    }
    if (block.kind === 'scorecard') {
      for (const g of block.groups) {
        for (const r of g.rows) if (r.footnote !== undefined) out.push({ at: `scorecard ${g.letter} ${r.metric}`, n: r.footnote });
      }
      if (block.priorFootnote !== null && block.priorFootnote !== undefined) out.push({ at: 'scorecard prior', n: block.priorFootnote });
    }
    if (block.kind === 'kpiTiles') {
      for (const t of block.tiles) if (t.trendFootnote !== null) out.push({ at: `tile ${t.label}`, n: t.trendFootnote });
    }
  });
  return out;
}

/**
 * Faults in one finished page's numbering: a superscript that resolves to no footnote, and
 * numbers that do not run 1..n.
 */
export function numberingFaults(page: Pick<PackPage, 'blocks' | 'footnotes'>): string[] {
  const faults: string[] = [];
  const have = new Set(page.footnotes.map((f) => f.number));
  for (const a of anchorsOf(page)) if (!have.has(a.n)) faults.push(`${a.at} -> ${a.n}: no such footnote`);
  const numbers = page.footnotes.map((f) => f.number);
  if (numbers.some((n, i) => n !== i + 1)) faults.push(`footnote numbers ${numbers.join(',')} do not run 1..${numbers.length}`);
  return faults;
}

/**
 * Faults in how the fitter carried a page: every superscript left on `after` must resolve to the
 * footnote text it resolved to on `before` (it is about the same row or column), and `after`'s
 * numbering must be clean.
 */
export function fitterFaults(before: PackPage, after: PackPage): string[] {
  const text = (p: Pick<PackPage, 'footnotes'>) => new Map(p.footnotes.map((f) => [f.number, f.text]));
  const was = text(before);
  const now = text(after);
  const wasAt = new Map(anchorsOf(before).map((a) => [a.at, was.get(a.n)]));
  const faults = numberingFaults(after);
  for (const a of anchorsOf(after)) {
    if (!wasAt.has(a.at)) { faults.push(`${a.at}: anchor was not on the page before the fit`); continue; }
    if (now.get(a.n) !== wasAt.get(a.at)) {
      faults.push(`${a.at} -> ${a.n}: "${now.get(a.n)?.slice(0, 40) ?? '(none)'}" but was about "${wasAt.get(a.at)?.slice(0, 40) ?? '(none)'}"`);
    }
  }
  return faults;
}
