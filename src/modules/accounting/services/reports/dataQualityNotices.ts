/**
 * Turns the resolver's data-quality warnings into the sentences a report
 * surface shows.
 *
 * Pure and presentation-free so it can be unit-tested without a DOM renderer;
 * `@/components/accounting/DataQualityNotice` renders whatever this returns.
 */

export interface UnclassifiedWarning {
  accounts: number;
  amount: number;
  message: string;
  /** Per-type breakdown; the remedy differs by type, so the notice names each. */
  byType?: Array<{ type: string; accounts: number; amount: number; defaultedTo: string }>;
}

export interface InventoryWarning {
  resolved: false;
  message: string;
}

export interface DataQualityInput {
  /**
   * Pre-built sentences from a caller that already ran this builder — the
   * income statement service does, and its result reaches the CSV and XLSX
   * exports. A surface passing these renders EXACTLY what the export carries;
   * re-deriving a partial input here is how the screen came to show fewer
   * caveats than the file downloaded from it.
   */
  notices?: string[] | null;
  unclassifiedAccounts?: UnclassifiedWarning | null;
  inventory?: InventoryWarning | null;
  /**
   * Income statement only. Gross profit there is `revenue - costOfSales`, so an
   * unclassified expense that is really cost of sales, or an unclassified
   * revenue that is really other income, moves it silently. Both are
   * conjecture — a ceiling, never a correction. (The third case, other income
   * shown inside turnover, was CERTAIN and is now fixed at source: the report
   * has an other-income line. See `./incomeStatementDisclosure.ts`.)
   */
  /** Expense that could belong above the gross profit line. */
  costOfSalesExposureAtMost?: number;
  /** Revenue that could be other income rather than turnover. */
  otherIncomeExposureAtMost?: number;
}

export const fmtZAR = (n: number): string =>
  `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @returns one sentence per caveat; an empty array means the figures rest on
 *   no assumption and the surface should show nothing.
 */
export function buildDataQualityNotices(input: DataQualityInput): string[] {
  if (input.notices && input.notices.length > 0) return [...input.notices];

  const notices: string[] = [];

  const unclassified = input.unclassifiedAccounts;
  if (unclassified && unclassified.accounts > 0) {
    // One line per account type: "39 expense accounts carrying R114 177 043,06
    // were treated as operating expenses rather than cost of sales" tells a
    // user what to go and fix. A lump "63 accounts" does not.
    const byType = unclassified.byType?.filter((t) => t.accounts > 0) ?? [];
    if (byType.length > 0) {
      for (const t of byType) {
        const plural = t.accounts === 1 ? '' : 's';
        const verb = t.accounts === 1 ? 'was' : 'were';
        notices.push(
          `${t.accounts} ${t.type} account${plural} carrying ${fmtZAR(t.amount)} ` +
            `${verb} treated as ${t.defaultedTo} because ${t.accounts === 1 ? 'it has' : 'they have'} ` +
            'no recognised subtype.',
        );
      }
    } else {
      const plural = unclassified.accounts === 1 ? '' : 's';
      const verb = unclassified.accounts === 1 ? 'has' : 'have';
      notices.push(
        `${unclassified.accounts} account${plural} carrying ${fmtZAR(unclassified.amount)} ` +
          `${verb} no recognised subtype, so a default was applied. Set account_subtype ` +
          'on them for accurate figures.',
      );
    }
  }

  // Stated as two numbers, never their sum: summed, Velocity's reads
  // R 200 037 895,31 against R 84 053 370,26 of revenue — a true bound and
  // worthless as information. The halves are separate questions with separate
  // remedies, and a reader can act on either.
  const cos = input.costOfSalesExposureAtMost ?? 0;
  const oi = input.otherIncomeExposureAtMost ?? 0;
  if (cos > 0 || oi > 0) {
    const clauses: string[] = [];
    if (cos > 0) clauses.push(`up to ${fmtZAR(cos)} of expense could belong above the line as cost of sales`);
    if (oi > 0) clauses.push(`up to ${fmtZAR(oi)} of revenue could be other income rather than turnover`);
    notices.push(
      `Gross profit above rests on classifications nobody has made: ${clauses.join(', and ')}. ` +
        'Those are ceilings on what is unclassified, not corrections to apply.',
    );
  }

  if (input.inventory && input.inventory.resolved === false) {
    notices.push(input.inventory.message);
  }

  return notices;
}
