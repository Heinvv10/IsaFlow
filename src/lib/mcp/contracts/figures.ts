/**
 * The figure registry: one name, one owner, one implementation.
 *
 * Cash has four answers across the dashboard, the balance sheet, the cash flow
 * and reality. AR has four. Revenue has two. That is not four bugs — it is four
 * implementations, and it regresses the moment two workstreams compute the same
 * figure separately, which six parallel teams are about to make very easy.
 *
 * A figure that appears here has ONE owning service function. Reports call the
 * owner; they do not re-derive it. The report then names the definition it used
 * in the envelope's `figureBasis`, so a disagreement between two reports is
 * impossible to mistake for a rounding difference — you can see immediately
 * whether they even claim to be answering the same question.
 *
 * TWO FIGURES THAT SHOULD BE EQUAL ARE STILL TWO FIGURES. `ar.subledger` (the
 * sum of open customer invoices) and `ar.control` (the balance on the AR control
 * account) are separate entries here, deliberately. Collapsing them into one
 * "AR" would destroy the only thing that can detect a reconciliation break —
 * and on Brightsphere the gap between them was R1,429,774. `reconcile_subledger`
 * exists precisely to compare them, and it cannot do that if they share an
 * implementation.
 *
 * ADDING A FIGURE: add it here in the same PR that computes it, with a real
 * owner. A definition with no owner is a promise, not a contract.
 */

export interface FigureDefinition {
  /** Stable id, `domain.figure.vN`. Returned to callers as `figureBasis`. */
  id: string;
  label: string;
  /**
   * The ONE service function that computes it, as `path#exportName` relative to
   * `src/modules/accounting/services/`. `null` means the owner is not settled
   * yet — see `contested`.
   */
  owner: string | null;
  /** What the figure counts. Prose, for the tool description and the reader. */
  includes: string;
  /** What it deliberately leaves out. The half people get wrong. */
  excludes: string;
  /**
   * Set when more than one implementation exists today and the owner above is
   * the one being converged ON. Names the others so a reviewer can tell whether
   * a PR has removed a duplicate or added one.
   */
  contested?: readonly string[];
}

function def(d: FigureDefinition): FigureDefinition {
  return d;
}

export const FIGURE_DEFINITIONS: Readonly<Record<string, FigureDefinition>> = {
  'ar.subledger.v1': def({
    id: 'ar.subledger.v1',
    label: 'Accounts receivable per the subledger',
    owner: 'ar/arAgingService#getARAging',
    includes: 'Open customer invoices, at total_amount less amount_paid, as at the reporting date.',
    excludes:
      'Cancelled invoices, and invoices the report could not age — a null due date appears in excludedRows, never in the total.',
  }),
  'ar.control.v1': def({
    id: 'ar.control.v1',
    label: 'Accounts receivable per the GL control account',
    // Settled by W2 as part of reconcile_subledger — it is the first report
    // that needs the two AR figures side by side.
    owner: null,
    includes: 'Balance on the system receivable control account as at the reporting date.',
    excludes: 'Anything posted to a duplicate control account. Duplicates are reported, not merged.',
  }),
  'ap.subledger.v1': def({
    id: 'ap.subledger.v1',
    label: 'Accounts payable per the subledger',
    owner: 'ap/apAgingService#getAPAging',
    includes: 'Open supplier invoices, at total_amount less amount_paid, as at the reporting date.',
    excludes: 'Cancelled invoices; unageable rows appear in excludedRows.',
  }),
  'ap.control.v1': def({
    id: 'ap.control.v1',
    label: 'Accounts payable per the GL control account',
    owner: null,
    includes: 'Balance on the system payable control account as at the reporting date.',
    excludes: 'Anything posted to a duplicate control account.',
    // 2001 / 2110 / SYS8 are all live on Brightsphere and the cash flow reads
    // the wrong one, which is how AP movement showed as R0.
    contested: ['afs/cashFlowDirectService#getCashFlowDirect resolves a different control account'],
  }),
  'cash.balance.v1': def({
    id: 'cash.balance.v1',
    label: 'Cash and cash equivalents',
    // Not settled. W3 owns this: it is the workstream that has to make the GL
    // balance, the statement balance and the computed balance agree, and it
    // cannot do that while three other call sites each answer differently.
    owner: null,
    includes: 'GL balance of every account of subtype bank, as at the reporting date.',
    excludes:
      'Clearing and suspense accounts, which are reported as exceptions instead — Interbank Transfer Clearing is R14,081,940 and a clearing account should be nil.',
    contested: [
      'bank/bankAccountStatusService#getBankAccountsStatus',
      'afs/cashFlowDirectService#getCashFlowDirect',
      'reports/balanceSheetService#getBalanceSheet',
    ],
  }),
  'equity.residual.v1': def({
    id: 'equity.residual.v1',
    label: 'Equity as a residual',
    owner: 'reports/balanceSheetService#getBalanceSheet',
    includes: 'Assets less liabilities. Balances by construction.',
    excludes:
      'Any assertion that the ledger agrees. A balance sheet that balances only because equity is the plug proves nothing, which is why equity.ledger.v1 is reported beside it.',
  }),
  'equity.ledger.v1': def({
    id: 'equity.ledger.v1',
    label: 'Equity per the ledger',
    owner: null,
    includes: 'Sum of posted equity account balances, including retained earnings.',
    excludes: 'Nothing. Any gap to equity.residual.v1 is the finding, not an error to suppress.',
    // R8.46m of retained earnings on Brightsphere has zero journal lines behind
    // it and four year-ends were never run. Reporting both numbers exposes that
    // in one call.
    contested: ['gl/openingBalanceEquityService — different basis'],
  }),
  'revenue.period.v1': def({
    id: 'revenue.period.v1',
    label: 'Revenue for a period',
    owner: 'reports/incomeStatementService#getIncomeStatement',
    includes: 'Posted income account movement over the period.',
    excludes: 'Cancelled invoices, and draft journals.',
  }),
  'costofsales.period.v1': def({
    id: 'costofsales.period.v1',
    label: 'Cost of sales for a period',
    owner: 'reports/incomeStatementService#getIncomeStatement',
    includes:
      'Posted movement on accounts whose SUBTYPE is cost of sales. Driven by subtype, never by the account NAME.',
    excludes:
      'Operating expenses. Two accounts typed default_expense overstated gross profit by R562,428 precisely because the bucket was chosen by name.',
  }),
  'vat.output.v1': def({
    id: 'vat.output.v1',
    label: 'Output tax for a VAT period',
    owner: 'reports/vat201Service#generateVAT201',
    includes: 'Output tax posted to the VAT control account over the period.',
    excludes:
      'Cancelled invoices. Box 1 must be derived from THESE journals, so that box 1 at 15% ties to this figure — it currently fails SARS’s own check by R5.1m on Velocity.',
  }),
  'vat.input.v1': def({
    id: 'vat.input.v1',
    label: 'Input tax for a VAT period',
    owner: 'reports/vat201Service#generateVAT201',
    includes: 'Input tax posted to the VAT control account over the period.',
    excludes:
      'Denied input tax (entertainment). Box 15 must be derived from these same journals so the 15% check ties.',
  }),
  'gl.trialbalance.v2': def({
    id: 'gl.trialbalance.v2',
    label: 'Trial balance',
    owner: 'gl/trialBalanceService#getTrialBalance',
    includes:
      'Opening, movement and closing for EVERY account, not only those with movement in the period.',
    excludes:
      'Nothing. An account omitted because it did not move in the month is the defect that let a 7-of-118 listing be stamped Balanced.',
  }),
} as const;

/**
 * Returns the `figureBasis` string for an envelope, and throws on an unknown id.
 *
 * Throwing is deliberate: a typo'd basis is worse than none, because it looks
 * authoritative in a response a reader is using to decide whether two reports
 * agree.
 */
export function figureBasis(id: string): string {
  if (!(id in FIGURE_DEFINITIONS)) {
    throw new Error(`unknown figure definition: ${id}`);
  }
  return id;
}

export function getFigureDefinition(id: string): FigureDefinition | undefined {
  return FIGURE_DEFINITIONS[id];
}

/** Figures whose owner is not settled yet. Every one is assigned to a workstream. */
export function unownedFigures(): FigureDefinition[] {
  return Object.values(FIGURE_DEFINITIONS).filter((d) => d.owner === null);
}
