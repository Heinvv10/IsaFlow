/**
 * EVERY TABLE IN THIS QUERY IS SCOPED TO THE TENANT, NOT ONLY THE ONE THE
 * WHERE CLAUSE NAMES.
 *
 * `getUnusualJournals` summed `jl.debit` over lines selected only by their FK
 * to the entry: `JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id`,
 * with `je.company_id` the only tenant predicate in the statement. Not
 * exploitable while every line's `company_id` matches its parent entry's —
 * which is why a blind security review rated it LOW — but the amount it
 * produces is printed as a matter on page 11 of a board pack, every sibling
 * query on this branch scopes each table it joins, and the root CLAUDE.md
 * rule is "ALWAYS add company_id to every DB query".
 *
 * ASSERTED AGAINST THE SQL THE TAGGED TEMPLATE ACTUALLY EMITS, not against
 * the source file: `sql` is stubbed here, so what is inspected is the query
 * text and the bound parameters the driver would receive. Dropping the
 * predicate from the service turns this red; a comment mentioning it does
 * not.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const sqlSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlSpy }));

import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

/** The statement as the driver sees it: the literal chunks with each
 *  interpolation rendered as the placeholder it becomes. */
function emitted(): { text: string; values: unknown[] } {
  const [strings, ...values] = sqlSpy.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
  return {
    text: strings.map((s, i) => (i === 0 ? s : `$${i}${s}`)).join(''),
    values,
  };
}

describe('getUnusualJournals orders its rows totally', () => {
  beforeEach(() => {
    sqlSpy.mockReset();
    sqlSpy.mockResolvedValue([]);
  });

  /**
   * WITHOUT THIS, THE QUERY PLAN PICKS WHICH MATTER A BOARD READS.
   *
   * The rows become page 11's matters, ranked by exposure, and the page
   * prints only what fits. Two journals of the same amount — Brightsphere has
   * two at exactly R161 000.00 — were separated by whatever order the grouped
   * scan returned, and adding the company_id predicate above was enough to
   * change the plan and swap them between two renders of unchanged data.
   *
   * `je.id` is what makes the order TOTAL: `entry_number` is nullable, so it
   * cannot be the last key. That is the half a "has an ORDER BY" assertion
   * would miss.
   */
  it('breaks a tie on a key that cannot itself tie', async () => {
    await getUnusualJournals(COMPANY, { start: '2026-01-01', end: '2026-09-07' });
    const sqlOnly = emitted().text.replace(/--[^\n]*/g, '');
    const order = /ORDER BY([\s\S]*)$/i.exec(sqlOnly);
    expect(order, 'the query has no ORDER BY, so its row order is the plan\'s').not.toBeNull();
    const clause = order![1]!.replace(/\s+/g, ' ').trim();
    // Amount first — the ranking the page itself argues for — then the date.
    expect(clause).toMatch(/^COALESCE\(SUM\(jl\.debit\), 0\) DESC, je\.entry_date DESC/i);
    // And a UNIQUE column last. `entry_number` is nullable, so an ORDER BY
    // ending there is still the plan's decision for the rows that share a
    // null — which is the half a bare "has an ORDER BY" assertion misses.
    expect(clause, 'the last sort key is not unique, so ties are still the plan\'s')
      .toMatch(/,\s*je\.id$/i);
  });
});

describe('getUnusualJournals scopes both tables it reads', () => {
  beforeEach(() => {
    sqlSpy.mockReset();
    sqlSpy.mockResolvedValue([]);
  });

  it('binds the company to the lines as well as to the entries', async () => {
    await getUnusualJournals(COMPANY, { start: '2026-01-01', end: '2026-09-07' });
    const { text, values } = emitted();
    // Strip SQL comments so a comment naming the predicate cannot satisfy it.
    const sqlOnly = text.replace(/--[^\n]*/g, '');
    const join = /JOIN\s+gl_journal_lines\s+jl\s+ON([\s\S]*?)WHERE/i.exec(sqlOnly);
    expect(join, 'the lines are no longer joined the way this test reads').not.toBeNull();
    expect(join![1]!, 'gl_journal_lines is joined with no company_id predicate')
      .toMatch(/jl\.company_id\s*=\s*\$\d+::UUID/i);
    expect(sqlOnly).toMatch(/je\.company_id\s*=\s*\$\d+::UUID/i);
    // The company id is what is bound, in every position that takes it — and
    // it is bound, never interpolated.
    expect(values.filter((v) => v === COMPANY).length).toBeGreaterThanOrEqual(2);
    expect(sqlOnly).not.toContain(COMPANY);
  });
});
