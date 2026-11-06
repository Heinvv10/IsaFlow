/**
 * THE FITTER MUST NOT LEAVE A SUPERSCRIPT POINTING AT NOTHING (or at a later note that took its number).
 *
 * `fitPageToBox` drops footnotes to make a page fit. The superscript anchored to a dropped note
 * (a table row's `footnote`, a `columnNotes` entry) used to stay printed, and the omission note
 * then took number max+1 -- sometimes the very number a surviving anchor already printed.
 *
 * Swept over the 2,560 page 6 shapes of the adversarial review of #1121, and checked on EVERY
 * page the fitter touches, not only page 6: each superscript left on a fitted page must resolve to
 * the footnote text it resolved to before the fit, and the numbers must run 1..n with no gaps.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import { log } from '@/lib/logger';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';

const fitted = vi.hoisted(() => ({ calls: [] as Array<{ before: unknown; after: unknown }> }));

vi.mock('@/modules/accounting/services/packs/pages/packPageFit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/packs/pages/packPageFit')>();
  return {
    ...actual,
    fitPageToBox: (page: PackPage, reserveMm?: number) => {
      const result = actual.fitPageToBox(page, reserveMm);
      fitted.calls.push({ before: page, after: result });
      return result;
    },
    fitPageReport: (page: PackPage, reserveMm?: number) => {
      const result = actual.fitPageReport(page, reserveMm);
      fitted.calls.push({ before: page, after: result.page });
      return result;
    },
  };
});

import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { BUDGET_COLUMNS_DROPPED_NOTE } from '@/modules/accounting/services/packs/pages/packIncomeBudget';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { BUDGET_COLUMN_NOTE_START } from '@/modules/accounting/services/packs/pages/packStatementFootnotes';
import { fitterFaults, numberingFaults } from './fixtures/packAnchors';
import { allPage6Shapes, page6Input } from './fixtures/page6Shapes';

describe('the 2,560-input shape sweep', () => {
  it('every superscript on every printed page resolves to the note about its row or column, numbers run 1..n', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const shapes = allPage6Shapes();
    expect(shapes).toHaveLength(2560);
    const printed: string[] = [];
    const fitter: string[] = [];
    let refused = 0;
    const unexpectedlyRefused: string[] = [];
    let budgetWithoutNote = 0;
    let captionDroppedBudgetKept = 0;
    let columnsNamed = 0;
    let columnsSilent = 0;
    let falseCompleteness = 0;
    let trimmedPages = 0;
    try {
      for (const shape of shapes) {
        fitted.calls.length = 0;
        const faults = new Set<string>();
        try {
          const doc = buildBoardPackPages(page6Input(shape));
          // A printed Budget column always carries the note that names its budget, wherever the
          // renumbering moved it (it is found by text: its number may now belong to another note).
          const p6 = doc.pages.find((p) => p.navLabel === 'Income statement')!;
          const hasBudget = p6.blocks.some((b) => b.kind === 'table' && b.table.columns.includes('budget'));
          if (hasBudget && !p6.footnotes.some((f) => f.text.startsWith(BUDGET_COLUMN_NOTE_START))) budgetWithoutNote += 1;
          // The caption is the fitter's FIRST lever, so a page that lost it can still carry the footnote that
          // names the Budget columns, and with it the columns: counted, and pinned below.
          if (hasBudget && !p6.blocks.some((b) => b.kind === 'narrative')) captionDroppedBudgetKept += 1;
          // Every input has a budget: a page 6 without the columns that prints an omission note names them.
          const omission = p6.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
          // No page lacking the columns may carry an omission note claiming every figure is complete.
          if (!hasBudget && p6.footnotes.some((f) => f.text.startsWith(OMISSION_MARK) && f.text.includes('Every figure'))) falseCompleteness += 1;
          if (!hasBudget) {
            const said = p6.footnotes.some((f) => f.text === BUDGET_COLUMNS_DROPPED_NOTE
              || (f.text.startsWith(OMISSION_MARK) && /; the Budget and Variance columns\./.test(f.text) && !f.text.includes('Every figure')));
            if (said) columnsNamed += 1;
            else columnsSilent += 1;
          }
          for (const page of doc.pages) {
            const call = fitted.calls.find((c) => (c.after as PackPage).blocks === page.blocks);
            const found = call === undefined ? numberingFaults(page) : fitterFaults(call.before as PackPage, page);
            for (const f of found) faults.add(`${page.navLabel}: ${f}`);
          }
        } catch (err) {
          if (!(err instanceof PackRefusal)) throw err;
          refused += 1;
          unexpectedlyRefused.push(JSON.stringify(shape));
        }
        if (faults.size > 0) printed.push(`${JSON.stringify(shape)} :: ${[...faults].join(' | ')}`);
        const inFitter = new Set<string>();
        for (const call of fitted.calls) {
          if (call.after !== call.before) trimmedPages += 1;
          for (const f of fitterFaults(call.before as PackPage, call.after as PackPage)) inFitter.add(f);
        }
        if (inFitter.size > 0) fitter.push(JSON.stringify(shape));
      }
    } finally {
      warn.mockRestore();
    }
    // The sweep must exercise the trimming path, or a green result proves nothing.
    expect(trimmedPages, 'no page was trimmed anywhere in the sweep').toBeGreaterThan(0);
    // `refused` is pinned at 0 (953 before the derived caption became page 6's last lever, 322 before
    // net-debit revenue with another line below zero got its two required disclosures under one heading):
    // every shape in the sweep gets its pack. A statement table modelled at its exact height gets the Budget columns
    // on more shapes and drops the caption (596, was 367) rather than the columns (1,116 name them, was 1,485).
    expect(unexpectedlyRefused).toEqual([]);
    expect({ printed: printed.length, fitter: fitter.length, budgetWithoutNote, captionDroppedBudgetKept, columnsSilent, falseCompleteness, columnsNamed, refused, sample: printed.slice(0, 3) }).toEqual(
      { printed: 0, fitter: 0, budgetWithoutNote: 0, captionDroppedBudgetKept: 596, columnsSilent: 0, falseCompleteness: 0, columnsNamed: 1116, refused: 0, sample: [] });
  }, 1_800_000);
});
