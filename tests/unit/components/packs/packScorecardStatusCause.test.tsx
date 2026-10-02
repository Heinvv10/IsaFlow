/**
 * Runs under vitest.components.config.ts.
 *
 * PAGE 9'S STATUS SAYS WHY A FIGURE IS MISSING: NOT STATED, OR NOT MEANINGFUL.
 *
 * Interest cover read NOT MEANINGFUL where the ledger records no interest
 * expense — a ratio that is not stated for want of an input, beside a
 * debt-to-equity that is not meaningful because negative equity inverts it.
 * Two causes, one word. A figure missing for lack of an input (no interest
 * recorded, no operating cash flow captured, no inventory classified) is
 * NOT STATED; NOT MEANINGFUL is kept for an undefined base.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from '../../services/packs/fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput } from '../../services/packs/fixtures/liveDemoBoardPack';

const NOT_RECORDED = ['Interest cover', 'Operating cash flow', 'Cash conversion cycle'];

const FIXTURES: Array<[string, BoardPackInput, string[]]> = [
  ['the live demo company, long window', liveDemoInput, ['Debt-to-equity']],
  ['the live demo company as it renders', liveDemoRenderedInput, ['Debt-to-equity']],
  ['Brightsphere', brightsphereLiveInput, ['Gross margin', 'Operating margin', 'Debtor days', 'Creditor days', 'Debt-to-equity']],
];

const clean = (s: string) => s.replace(/<[^>]*>/g, '').trim();

describe('page 9\'s status column names the cause of a missing figure', () => {
  it.each(FIXTURES)('%s', (_name, input, undefinedBase) => {
    const html = renderToStaticMarkup(<PackPagesView document={buildBoardPackPages(input)} />);
    const status = new Map([...html.matchAll(/<tr class="pack-scorecard-row">(.*?)<\/tr>/g)].map((row) => {
      const cells = [...row[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => clean(c[1]!));
      return [cells[0]!.replace(/\d+$/, ''), cells[cells.length - 1]!] as const;
    }));
    const missing = [...status].filter(([, s]) => s === 'Not stated' || s === 'Not meaningful');
    expect(Object.fromEntries(missing)).toEqual(Object.fromEntries([
      ...undefinedBase.map((m) => [m, 'Not meaningful']),
      ...NOT_RECORDED.filter((m) => !(input === brightsphereLiveInput && m === 'Operating cash flow')).map((m) => [m, 'Not stated']),
    ]));
  });
});
