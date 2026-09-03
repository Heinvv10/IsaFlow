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
    const plural = unclassified.accounts === 1 ? '' : 's';
    const verb = unclassified.accounts === 1 ? 'has' : 'have';
    notices.push(
      `${unclassified.accounts} account${plural} carrying ${fmtZAR(unclassified.amount)} ` +
        `${verb} no recognised subtype and ${unclassified.accounts === 1 ? 'has' : 'have'} been ` +
        'treated as current. Set account_subtype on them for an accurate ' +
        'current/non-current split.',
    );
  }

  if (input.inventory && input.inventory.resolved === false) {
    notices.push(input.inventory.message);
  }

  return notices;
}
