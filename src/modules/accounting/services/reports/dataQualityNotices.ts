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
  unclassifiedAccounts?: UnclassifiedWarning | null;
  inventory?: InventoryWarning | null;
}

const fmtZAR = (n: number): string =>
  `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @returns one sentence per caveat; an empty array means the figures rest on
 *   no assumption and the surface should show nothing.
 */
export function buildDataQualityNotices(input: DataQualityInput): string[] {
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

  if (input.inventory && input.inventory.resolved === false) {
    notices.push(input.inventory.message);
  }

  return notices;
}
