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
  'cash.ledger.v1': def({
    id: 'cash.ledger.v1',
    label: 'Cash and cash equivalents, per the ledger',
    owner: 'bank/cashBalanceService#getCashBalance',
    includes:
      'Posted GL balance of every account of subtype bank OR cash, as at the reporting date, INCLUDING deactivated accounts — is_active is a picker flag, and Brightsphere\'s deactivated 1110 carries R6,550 of cash.',
    excludes:
      'Draft journals. And the statement feed, which is cash.statement.v1 and is a DIFFERENT question, not a rival implementation of this one. Clearing and suspense accounts fall outside by subtype; no clearing SUBTYPE exists in this schema, so finding a non-nil clearing account by NAME belongs to chart_of_accounts_health — account name is the discriminator that overstated gross profit by R562,428.',
  }),
  'cash.statement.v1': def({
    id: 'cash.statement.v1',
    label: 'Cash per the imported bank statements',
    owner: 'bank/bankAccountStatusService#getBankAccountsStatus',
    includes: 'SUM of bank_transactions.amount per bank account — the evidence, i.e. what the bank says.',
    excludes:
      'Any recorded opening balance (that column is display metadata no balance calculation adds), and any GL movement with no statement line behind it. It is NOT a worse version of cash.ledger.v1: the two answer different questions and the gap between them is the output of bank_statement_coverage, which decomposes it exactly into GL-only movement and statement-only rows. Do not reconcile them into one number. NOTE this owner still filters is_active = TRUE and so omits a deactivated bank account carrying R6,550; bank_statement_coverage is the complete surface.',
    contested: [
      'reports/kpiDashboardService — same basis, same is_active filter, computed separately for the dashboard tile',
    ],
  }),
  'fiscalyear.start.v1': def({
    id: 'fiscalyear.start.v1',
    label: 'The month a company\'s financial year begins',
    owner: 'gl/fiscalYearBasis#getFiscalYearStartMonth',
    includes:
      'companies.financial_year_start as a month 1-12. Write paths (createFiscalYear, year_end_close) call it with NO fallback and take the refusal; a read path that must survive a misconfigured tenant opts into a fallback at the call site, where the assumption is visible.',
    excludes:
      'fiscal_periods.fiscal_year, which is CALENDAR-based and is not this: February 2026 is stored as fiscal_year 2026 and belongs to the March-2025 fiscal year. Also excludes any silent default — all 13 production companies declare 3, and assuming March for a company genuinely on a December year end produces a year-end close a full quarter out with nothing flagging it.',
    contested: [
      'afs/cipcFilingGuideService.ts:125 — financial_year_start || 3',
      'afs/pisCalculatorService.ts:266 — financial_year_start || 3',
      'afs/complianceAlertService.ts:159 — financial_year_start || 3',
      'pages/api/payroll/period-context.ts:42 — COALESCE(financial_year_start, 3)',
      'pages/api/accounting/afs/pis-score.ts:37 — COALESCE(financial_year_start, 3)',
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
    // Settled by W4. NOT vat201Service#generateVAT201, which the specification
    // named: that is the invoice-based generator the VAT-return PAGE uses, and
    // it was never what vat_status called. The MCP tool called
    // vatReturnService#getVATReturn, whose tax came from the VAT control
    // accounts while its box 1 and box 15 values came from the invoice tables —
    // two populations, one question, and box 15 out by R5.1m on Velocity.
    owner: 'reports/vat201ReportService#getVat201Report',
    includes: 'Output tax posted to the VAT control account over the period.',
    excludes:
      'Cancelled invoices — their tax leaves the boxes and is named in excludedRows, because the journal is still posted and the GL still has it. Box 1 is derived from THESE journals, so box 1 at 15% ties to this figure: R0.00 of variance on Velocity 2026-07/08, against R5.1m before.',
  }),
  'vat.input.v1': def({
    id: 'vat.input.v1',
    label: 'Input tax for a VAT period',
    owner: 'reports/vat201ReportService#getVat201Report',
    includes: 'Input tax posted to the VAT control account over the period.',
    excludes:
      'Denied input tax (entertainment), and tax on an account with no VAT posting treatment — R4,917,814.24 on Velocity SYS-9, which appears in excludedRows rather than in a box. Box 15 is derived from these same journals, so the 15% check ties to R4,407.45 on Velocity 2026-07/08 rather than R5.1m.',
  }),
  'payroll.employmentcost.v1': def({
    id: 'payroll.employmentcost.v1',
    label: 'Employment cost for a pay run',
    owner: 'payroll/payrollJournalBuilder#buildPayrollJournalPlan',
    includes:
      'Gross pay plus the EMPLOYER share of UIF plus SDL — the full cost of employing the staff in the period, as it would be debited to labour.',
    excludes:
      'The employee halves of PAYE and UIF, which are deductions from gross rather than an additional cost, and ETI, which is an offset against PAYE remitted rather than a reduction in cost. The poster currently subtracts ETI from the labour debit and credits it nowhere, which leaves the journal unbalanced by exactly the ETI — reported as a blocker, not corrected here.',
  }),
  'payroll.netpay.v1': def({
    id: 'payroll.netpay.v1',
    label: 'Net pay for a pay run',
    owner: 'payroll/payrollJournalBuilder#buildPayrollJournalPlan',
    includes: 'What the employees are actually paid, per the run header total.',
    excludes:
      'Every employer contribution. Reported separately from payroll.employmentcost.v1 on purpose: net pay is all these books have ever carried, and the gap between the two figures IS the understatement of employment cost. Collapsing them would destroy the only thing that measures it.',
  }),
  'budget.actual.v1': def({
    id: 'budget.actual.v1',
    label: 'Actual movement, as compared against a budget',
    owner: 'reports/budgetVarianceService#getBudgetVariance',
    includes:
      'Posted journal-line movement per revenue or expense account over the window, signed so that a revenue credit and an expense debit are both positive. The same number the trial balance shows for the account.',
    excludes:
      'Draft journals, and every layer the income statement adds on top: no cost-of-sales bucketing, no other-income or finance-cost section, no tax. That is deliberate — incomeStatementService has open defects in exactly that layering (rolling-window comparative, cost of sales chosen by account NAME), and a variance against a net profit known to be wrong would carry more authority than it deserves.',
    contested: [
      'reports/incomeStatementService#getIncomeStatement reports P&L for the same accounts through a different, defective classification layer',
    ],
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
