/**
 * Page 11 assembly — not the sources. Every source is mocked; these tests
 * pin company scoping, quantum ranking, the "no matters" fallback (spec
 * §7.1 criterion 3: an empty page never ships), and the rule this file
 * exists to enforce: a source that throws becomes a NAMED matter, never a
 * silent omission.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgingReport } from '@/modules/accounting/services/reports/agingReportService';
import type { UnusualJournalFlag } from '@/modules/accounting/services/reports/unusualJournalsService';
import type { OverdueFiling } from '@/modules/accounting/services/reports/statutoryFilingsService';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';

// Hoisted: `vi.mock` factories run before module-level consts are initialised.
const { agingSpy, bankSpy, journalSpy, filingSpy, warn } = vi.hoisted(() => ({
  agingSpy: vi.fn(),
  bankSpy: vi.fn(),
  journalSpy: vi.fn(),
  filingSpy: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/modules/accounting/services/reports/agingReportService', () => ({
  getAgingReport: agingSpy,
}));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({
  getBankAccountsStatus: bankSpy,
}));
vi.mock('@/modules/accounting/services/reports/unusualJournalsService', () => ({
  getUnusualJournals: journalSpy,
}));
vi.mock('@/modules/accounting/services/reports/statutoryFilingsService', () => ({
  getOverdueStatutoryFilings: filingSpy,
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

import { buildMatters } from '@/modules/accounting/services/packs/pages/packMatters';

const window: PeriodWindow = { start: '2026-01-01', end: '2026-08-31' };

function emptyAging(): AgingReport {
  return {
    asAt: window.end,
    buckets: [],
    totals: { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, total: 0 },
    excluded: [],
    excludedTotal: 0,
    entityUniverse: 0,
    unappliedReceipts: 0,
    subledgerTotal: 0,
    postedThrough: null,
  };
}

/** `largestTotal` is the single biggest debtor's balance; `otherTotals` are
 *  spread across several smaller entities (each strictly below
 *  `largestTotal`), so the fixture cannot accidentally make some OTHER
 *  entity the largest. `totals.total` is the sum of all of them. */
function agingWithConcentration(largestTotal: number, otherTotals: number[]): AgingReport {
  const buckets = [
    {
      entityId: 'e0', entityName: 'Big Debtor',
      current: largestTotal, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: largestTotal,
    },
    ...otherTotals.map((total, i) => ({
      entityId: `e${i + 1}`, entityName: `Other Debtor ${i + 1}`,
      current: total, days30: 0, days60: 0, days90: 0, days120Plus: 0, total,
    })),
  ];
  const grandTotal = largestTotal + otherTotals.reduce((s, t) => s + t, 0);
  return {
    ...emptyAging(),
    buckets,
    totals: { current: grandTotal, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, total: grandTotal },
  };
}

/** Every source resolves to an empty/clean result — the fixture for the
 *  "no matters" test and the default for tests that only care about one
 *  source misbehaving. */
function everySourceEmpty(): void {
  agingSpy.mockResolvedValue(emptyAging());
  bankSpy.mockResolvedValue([]);
  journalSpy.mockResolvedValue([]);
  filingSpy.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  everySourceEmpty();
});

describe('buildMatters', () => {
  it('scopes every source query to the company', async () => {
    await buildMatters('c1', window);
    for (const spy of [agingSpy, journalSpy, filingSpy, bankSpy]) {
      expect(spy).toHaveBeenCalled();
      for (const call of spy.mock.calls) expect(call[0]).toBe('c1');
    }
  });

  it('ranks matters by quantum, largest first', async () => {
    // Deliberately NOT in descending order across sources, and deliberately
    // mixes in a null-quantum matter (the overdue filing) so a fixture that
    // is already sorted, or one where every quantum is non-null, cannot pass
    // a broken implementation by accident.
    agingSpy.mockResolvedValue(agingWithConcentration(50_000, [40_000, 40_000, 30_000, 30_000])); // 25% of 200,000 -> flagged, quantum 50,000
    bankSpy.mockResolvedValue([{ unreconciled_count: 2, unreconciled_balance: 20_000 }]);
    const journalFlags: UnusualJournalFlag[] = [
      { entryId: 'j1', entryNumber: 'JE-1', entryDate: '2026-03-01', description: 'Estimate', amount: 90_000, reason: 'round_number' },
      { entryId: 'j2', entryNumber: 'JE-2', entryDate: '2026-04-01', description: 'Late entry', amount: 5_000, reason: 'backdated' },
    ];
    journalSpy.mockResolvedValue(journalFlags);
    const filings: OverdueFiling[] = [
      { filingType: 'Annual Financial Statements', fiscalYear: 2025, deadline: '2026-03-31', daysOverdue: 10 },
    ];
    filingSpy.mockResolvedValue(filings);

    const matters = (await buildMatters('c1', window)).matters;
    const quanta = matters.map((m) => Math.abs(m.quantum ?? 0));
    expect([...quanta].sort((a, b) => b - a)).toEqual(quanta);
    // Pin the actual order, not just "is sorted" — a fixture where every
    // quantum happens to already be descending can't distinguish a real sort
    // from no sort at all.
    expect(quanta).toEqual([90_000, 50_000, 20_000, 5_000, 0]);
  });

  it('returns an explicit "no matters" item rather than an empty page', async () => {
    // Rubric criterion 3: a page with nothing on it does not ship.
    everySourceEmpty();
    const matters = (await buildMatters('c1', window)).matters;
    expect(matters).toHaveLength(1);
    expect(matters[0]?.issue).toMatch(/no matters/i);
    expect(matters[0]?.quantum).toBeNull();
  });

  it('reports a source that failed rather than silently omitting its matters', async () => {
    agingSpy.mockRejectedValue(new Error('timeout'));
    const matters = (await buildMatters('c1', window)).matters;
    expect(matters.some((m) => m.issue.match(/aged debtors could not be assessed/i))).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  /**
   * TWO DEBTORS OWING THE IDENTICAL AMOUNT MUST NOT BE SEPARATED BY THE ORDER
   * THE SNAPSHOT CAME BACK IN.
   *
   * This sentence prints a CUSTOMER'S NAME. `[...buckets].sort((a, b) => b.total
   * - a.total)` is stable, so the winner of an exact tie was whichever of them
   * the aging read happened to return first — a query-plan decision, on
   * unchanged data, in the governance section of a document a director
   * forwards to their bank. Same class as `getUnusualJournals` having no
   * ORDER BY.
   *
   * ASSERTED FROM BOTH INPUT ORDERS, which is the only way to see it: one
   * order alone passes whatever the tie-break is.
   */
  it('names the same tied debtor whichever order the aging returns them in', async () => {
    const tied = (first: string, second: string): AgingReport => {
      const base = agingWithConcentration(50_000, [10_000]);
      return {
        ...base,
        buckets: [
          { entityId: first, entityName: first, current: 50_000, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 50_000 },
          { entityId: second, entityName: second, current: 50_000, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 50_000 },
        ],
        totals: { ...base.totals, total: 100_000 },
      };
    };

    agingSpy.mockResolvedValue(tied('Alpha Traders', 'Beta Supplies'));
    const forwards = (await buildMatters('c1', window)).matters
      .find((m) => m.issue.startsWith('Aged debtor concentration'))!.issue;
    agingSpy.mockResolvedValue(tied('Beta Supplies', 'Alpha Traders'));
    const backwards = (await buildMatters('c1', window)).matters
      .find((m) => m.issue.startsWith('Aged debtor concentration'))!.issue;

    expect(forwards, 'the fixture did not reach the concentration matter').toContain('Alpha Traders');
    expect(backwards, 'the debtor named depends on the order the aging read returned')
      .toBe(forwards);
  });

  /**
   * THE PERCENTAGE MUST BE CHECKABLE OFF THE SHEET.
   *
   * The matter read "Blitz Fibre is 77.0% of total debtors owed" with a
   * quantum of 3 192, and NO receivables figure prints anywhere in the twelve
   * sheets — so the one percentage in the governance table was the one claim
   * in the pack a director could not test. The eleventh gate could not either,
   * and had to report it as undecidable from the paper: 3 192 is also
   * Brightsphere's Total assets on page 7, so the sheet handed the reader a
   * plausible base that is the wrong one.
   *
   * (Queried against the dev ledger: the two are R3 191 824 of aged trade
   * receivables and R3 191 945.16 of total assets — different figures that
   * round to the same R'000. The percentage is taken against
   * `getAgingReport(...).totals.total`, so the number was never wrong; what
   * was missing was its base.)
   *
   * So the base is stated, and this reproduces the division a director would
   * do: the two printed figures must give the printed percentage.
   *
   * AND THE NUMERATOR IS STATED TOO, WHICH IS THE TWELFTH GATE'S WORST
   * DEFECT. The sentence printed the share and the base and left this
   * matter's own exposure to page 11's quantum column — a column page 4's
   * action panel does not have. Brightsphere's page 4 therefore headlined
   * "the largest carrying 4 128 of exposure" over a panel whose largest
   * printed figure was 4 146, the debtors BASE: the headline was true, its
   * subject (3 192) was two sheets away, and the figure that WAS on the sheet
   * pointed at the other conclusion. A page whose standard is that every
   * claim is checkable where it is made cannot rank a matter by a number it
   * does not print, so all three figures are in the sentence.
   */
  it('prints the base its percentage is a share of, and the two reproduce it', async () => {
    agingSpy.mockResolvedValue(agingWithConcentration(3_191_824, [488_225, 465_750, 172.5]));

    const matter = (await buildMatters('c1', window)).matters
      .find((m) => m.issue.startsWith('Aged debtor concentration'))!;
    const { issue } = matter;

    // Read back exactly as a reader does: this account's own exposure, the
    // percentage, and the base.
    const owed = Number(/owes ([\d\u2009\u00a0 ]+),/.exec(issue)![1]!.replace(/[^\d]/g, ''));
    const pct = Number(/([\d.]+)% of all debtors owed/.exec(issue)![1]);
    const base = Number(/come to ([\d\u2009\u00a0 ]+)/.exec(issue)![1]!.replace(/[^\d]/g, ''));
    expect(base, 'the matter states no base for its percentage').toBeGreaterThan(0);

    // AND THE BASE NAMES THE REPORT IT IS READ OFF. Brightsphere's page 11
    // states debtors of 4 146 and its page 7 states trade receivables of
    // (330): the aging total is what customers owe, the balance-sheet line is
    // the control account net of credit balances, and until the report was
    // named a director comparing two sheets read a contradiction between
    // them.
    expect(issue, 'the base does not say which report it comes from')
      .toContain('of all debtors owed on the aged debtors report');

    // The quantum the table prints, at the pack's own scale — and the
    // sentence states the SAME figure, because page 4 has no column to read
    // it from.
    const quantum = Math.round(3_191_824 / 1_000);
    expect(owed, 'the matter does not print its own exposure').toBe(quantum);
    expect(Math.round(matter.quantum! / 1_000)).toBe(owed);
    expect(base).toBe(Math.round(4_145_971.5 / 1_000));
    expect((owed / base) * 100, 'the printed figures do not give the printed percentage')
      .toBeCloseTo(pct, 1);

    // AND THE EXPOSURE IS THE SMALLER OF THE TWO FIGURES IT SITS BESIDE,
    // which is the fact page 4 was unable to show.
    expect(owed).toBeLessThan(base);
  });

  it('keeps the exception itself off the page and out of the log line', async () => {
    // The matter still appears — that is this file's rule. What came off the
    // PAGE is `String(error)`, which put a driver's message, and whatever a
    // database chooses to put in one, into the issue column of a document a
    // director forwards to their bank. The reader's decision is the same
    // either way.
    //
    // AND WHAT CAME OFF THE LOG LINE IS THE SAME TEXT, for the same reason
    // one step further out: a node-postgres message carries whatever the
    // server put in it — "duplicate key value violates unique constraint …
    // Key (email)=(…)" is a real one — so the free text is a tenant's data in
    // a line that outlives the request. What triage needs is the class, the
    // SQLSTATE where there is one, and WHICH check failed; all three are
    // there.
    const pgError = Object.assign(
      new Error('connection terminated: pg_relation_size'),
      { code: '57P01' },
    );
    agingSpy.mockRejectedValue(pgError);
    const matters = (await buildMatters('c1', window)).matters;
    const failed = matters.find((m) => m.issue.startsWith('aged debtors could not be assessed'))!;
    expect(failed.issue).not.toMatch(/pg_relation_size|Error:/);
    const logged = warn.mock.calls.at(-1)?.[1] as { error: string; source: string };
    expect(logged.error).not.toMatch(/pg_relation_size|connection terminated/);
    expect(logged.error).toBe('Error (SQLSTATE 57P01)');
    expect(logged.source).toBe('aged debtors');
  });

  it('names the class alone where the failure carries no SQLSTATE', async () => {
    agingSpy.mockRejectedValue(new TypeError('cannot read properties of undefined'));
    await buildMatters('c1', window);
    expect((warn.mock.calls.at(-1)?.[1] as { error: string }).error).toBe('TypeError');
  });

  /**
   * THE ISSUE COLUMN IS PROSE A DIRECTOR READS, and it is the one place the
   * document-wide prose gate cannot help: `packProseIntegrity` skips these
   * fields because they interpolate journal descriptions and entity names
   * straight out of a company's ledger, and refusing to render a board pack
   * because a bookkeeper typed "Item(s) received" is a worse failure than the
   * leak it would catch. So the TEMPLATES are held here, at the source, where
   * the pack's words and the ledger's are still separable.
   */
  describe('the sentences this page composes', () => {
    it('counts in words rather than hedging with a developer\'s plural', async () => {
      bankSpy.mockResolvedValue([
        { unreconciled_count: 1, unreconciled_balance: 4_000 },
        { unreconciled_count: 11, unreconciled_balance: 91_000 },
      ]);
      filingSpy.mockResolvedValue([
        { filingType: 'Annual Financial Statements', fiscalYear: 2024, deadline: '2024-08-28', daysOverdue: 739 },
        { filingType: 'Annual Return', fiscalYear: 2026, deadline: '2026-08-27', daysOverdue: 1 },
      ] as OverdueFiling[]);
      const issues = (await buildMatters('c1', window)).matters.map((m) => m.issue);

      expect(issues.some((i) => i.includes('(s)'))).toBe(false);
      expect(issues.some((i) => i.includes('12 unreconciled bank items across 2 bank accounts'))).toBe(true);
      // Both branches of every plural, in one fixture: 739 days and 1 day.
      // NO VERB BEFORE THE COUNT. "Annual Financial Statements is 739 days
      // overdue" printed four times per pack, in the first action item a
      // director reads; `filingType` is ledger text, so no verb this module
      // writes can agree with it.
      expect(issues.some((i) => i.includes('for FY2024: 739 days overdue'))).toBe(true);
      expect(issues.some((i) => i.includes('for FY2026: 1 day overdue'))).toBe(true);
      expect(issues.some((i) => /Statements is \d/.test(i))).toBe(false);
    });

    it('sets a deadline in words, not in the storage format', async () => {
      filingSpy.mockResolvedValue([
        { filingType: 'Annual Financial Statements', fiscalYear: 2024, deadline: '2024-08-28', daysOverdue: 739 },
      ] as OverdueFiling[]);
      const issue = (await buildMatters('c1', window)).matters.map((m) => m.issue).join(' ');
      expect(issue).toContain('due 28 August 2024');
      expect(issue).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('leaves the rand amount to the quantum column rather than restating it in another convention', async () => {
      // `toLocaleString('en-ZA')` printed `R1,234,567.89` — comma-separated,
      // in rands, unbracketed — in the same table row as a quantum column
      // stated in R'000 with spaces and brackets.
      bankSpy.mockResolvedValue([{ unreconciled_count: 3, unreconciled_balance: 1_234_567.89 }]);
      const matter = (await buildMatters('c1', window)).matters
        .find((m) => m.issue.includes('unreconciled bank item'))!;
      expect(matter.issue).not.toMatch(/R\s?1[ ,]?234/);
      expect(matter.quantum).toBeCloseTo(1_234_567.89, 2);
    });
  });

  it('does not let one failed source suppress the matters from the others', async () => {
    agingSpy.mockRejectedValue(new Error('timeout'));
    bankSpy.mockResolvedValue([{ unreconciled_count: 3, unreconciled_balance: 15_000 }]);
    const matters = (await buildMatters('c1', window)).matters;
    expect(matters.some((m) => m.issue.match(/aged debtors could not be assessed/i))).toBe(true);
    expect(matters.some((m) => m.issue.match(/unreconciled bank item/i))).toBe(true);
  });
});
