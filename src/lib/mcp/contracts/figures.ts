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

/**
 * Appended to every figure derived from `account_subtype`.
 *
 * A figure driven by subtype is exactly as good as the subtypes, and on these
 * books they barely exist. Stating it once and reusing it is better than four
 * paraphrases that drift.
 */
const COVERAGE_CAVEAT =
  ' This figure is only as good as account_subtype, and on these books most accounts have none:'
  + ' 100% of Velocity Fibre\'s revenue (R84,053,370.26) and 97.6% of its expenses (R115,984,525.05)'
  + ' sit on accounts whose subtype is NULL or a default_* placeholder, and its classified cost of'
  + ' sales is R2,885,070.10. profit_and_loss reports that coverage as a mandatory exception at every'
  + ' detail level; read it before acting on any band.';

export const FIGURE_DEFINITIONS: Readonly<Record<string, FigureDefinition>> = {
  'ar.subledger.v1': def({
    id: 'ar.subledger.v1',
    label: 'Accounts receivable per the subledger',
    owner: 'ar/arAgingService#getARAging',
    includes:
      'Customer invoices still outstanding AS AT the reporting date, at total_amount less the settlement that can be dated to on or before it. An invoice with no due date IS included, aged from its invoice date — it is not dropped and it is not an excludedRow.',
    excludes:
      'Draft and cancelled invoices. Invoices raised AFTER the reporting date. Settlement that carries no date — bank-match confirmation and the Sage import both write amount_paid with no dated trail — stays in the baseline, so a historical figure can UNDERSTATE and will never report a settled invoice as outstanding.',
  }),
  'ar.control.v1': def({
    id: 'ar.control.v1',
    label: 'Accounts receivable per the GL control account',
    // Settled by W2 as part of reconcile_subledger — it is the first report
    // that needs the two AR figures side by side.
    owner: null,
    includes:
      'Balance on EVERY candidate receivable control account as at the reporting date, deactivated ones included — is_active is a picker flag. Candidates are found by subtype AND by where customer documents actually posted, because the accounts carrying money here have a NULL subtype.',
    excludes:
      'Accounts the invoice journals move AGAINST the control direction: those are the contra leg, not the control. Nothing is merged — every candidate is reported with how it was found, and controlAccountAmbiguous says when more than one exists.',
  }),
  'ap.subledger.v1': def({
    id: 'ap.subledger.v1',
    label: 'Accounts payable per the subledger',
    owner: 'ap/apAgingService#getAPAging',
    includes:
      'Supplier bills still outstanding AS AT the reporting date, at total_amount less the settlement that can be dated to on or before it. A bill with no due date IS included, aged from its invoice date.',
    excludes:
      'Draft and cancelled bills, and bills raised AFTER the reporting date. Undated settlement stays in the baseline — see ar.subledger.v1. Note that 397 bills on one production company carry payment_matched = true with amount_paid = 0, so they are counted here as fully owed; reconcile_subledger reports them in settlementFlagged.',
  }),
  'ap.control.v1': def({
    id: 'ap.control.v1',
    label: 'Accounts payable per the GL control account',
    owner: null,
    includes:
      'Balance on EVERY candidate payable control account as at the reporting date, deactivated ones included.',
    excludes:
      'Accounts the bill journals net-DEBIT, which are the tax or expense leg. SYS-9 VAT Payable — subtype NULL, type liability, touched by 356 Velocity bill journals — was adopted as a control account on that basis and brought -R4,917,814.24 into the balance, which the reconciliation then explained with a 356-document item. Nothing is merged.',
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
    // Settled by W2 with balance_sheet v2, the first report that needs both
    // equity figures side by side.
    //
    // The owner is `getEquityBases`, NOT `getBalanceSheet`. That service's
    // `totalEquity` computes retained earnings as revenue less expenses and
    // injects it, so it equals equity.residual.v1 by construction — it is the
    // residual wearing the ledger's name, and reporting the two beside each
    // other agreed to the cent on all three production companies. The equity
    // ACCOUNTS say otherwise: Brightsphere and Velocity Fibre each carry R0.00
    // posted, so every cent of R8,394,848.60 and −R34,816,224.89 respectively
    // is a plug no year-end close has ever posted.
    //
    // `contested` is now EMPTY, and that is a correction rather than a
    // clean-up. `gl/openingBalanceEquityService` was listed as a rival basis
    // for this figure; it is not. It resolves (and creates on first use) ONE
    // clearing account carrying the reserved `opening_balance_equity` subtype.
    // It computes no total and answers a different question, so there was never
    // a duplicate implementation to remove.
    id: 'equity.ledger.v1',
    label: 'Equity per the ledger',
    owner: 'reports/balanceSheetService#getEquityBases',
    includes:
      'Sum of POSTED equity-account balances as at the reporting date. Nothing derived, nothing injected.',
    excludes:
      'The retained earnings the balance sheet DERIVES from revenue less expenses. That figure is reported separately as retainedEarningsDerived, and the gap to equity.residual.v1 is exactly it — the finding, not an error to suppress.',
  }),
  'revenue.period.v1': def({
    id: 'revenue.period.v1',
    label: 'Revenue for a period',
    owner: 'reports/incomeStatementService#getIncomeStatement',
    includes: 'Posted income account movement over the period.',
    excludes:
      'Other income, cancelled invoices, and draft journals. This is TURNOVER — accounts typed other_income are reported on their own line, below gross profit. ' + COVERAGE_CAVEAT,
    // CONVERGED. This entry previously recorded a "presentational divergence,
    // deliberate and temporary": getIncomeStatement counted other income as
    // turnover and put finance cost and tax inside operating expenses, while
    // aggregateFigures split both. The note claimed the two "agree on the
    // BOTTOM LINE to the cent — the only difference is which band a figure
    // sits in", which was true of NET profit and false of GROSS: the page and
    // the MCP `profit_and_loss` tool printed different gross profits, by
    // exactly the other-income total, and neither said so (finding B75).
    //
    // Both now band through the SAME exported functions,
    // gl/accountClassification#expenseBand and #revenueBand, so there is one
    // definition and no room to drift. `incomeStatementConvergence.test.ts`
    // asserts agreement band for band — turnover, other income, cost of sales,
    // operating expenses, other expenses, gross profit AND net profit — so a
    // future edit to either side fails rather than silently re-diverging.
    // Net profit is unchanged to the cent by the split, which is what proves it
    // was a reclassification and not a restatement.
  }),
  'costofsales.period.v1': def({
    id: 'costofsales.period.v1',
    label: 'Cost of sales for a period',
    owner: 'reports/incomeStatementService#getIncomeStatement',
    includes:
      'Posted movement on accounts whose SUBTYPE is cost of sales. Driven by subtype, never by the account NAME.',
    excludes:
      'Operating expenses. The audit reported that two accounts typed default_expense overstated gross profit by R562,428 because the bucket was chosen by NAME — and read the sign backwards: under the SUBTYPE rule those accounts are NOT cost of sales, so gross profit is HIGHER, not lower. Brightsphere carries R574,253.66 of them today. Which treatment is right is a chart-of-accounts question. ' + COVERAGE_CAVEAT,
    contested: [
      'gl/accountClassification#aggregateFigures — agrees with this owner on cost of sales, and since the convergence recorded on revenue.period.v1, on every other band too.',
    ],
  }),
  'otherincome.period.v1': def({
    id: 'otherincome.period.v1',
    label: 'Other income for a period',
    owner: 'gl/accountClassification#aggregateFigures',
    includes:
      'Posted movement on revenue-typed accounts whose SUBTYPE canonicalises to other_income — interest received, forex gains, recoveries.',
    excludes:
      'Turnover. This is a separate question from revenue.period.v1, not a slice of it: other income is not trading revenue and must not reach gross profit. It no longer does — see the convergence note on revenue.period.v1. ' + COVERAGE_CAVEAT,
  }),
  'financecost.period.v1': def({
    id: 'financecost.period.v1',
    label: 'Finance cost for a period',
    owner: 'gl/accountClassification#aggregateFigures',
    includes:
      'Posted movement on expense accounts whose SUBTYPE canonicalises to finance_cost — interest paid, bank charges of a financing nature.',
    excludes:
      'Operating expenses. Reported below the operating line so operating profit means what it says. getIncomeStatement now agrees — it reports an Other Expenses section and an Operating Profit line. ' + COVERAGE_CAVEAT,
  }),
  'tax.period.v1': def({
    id: 'tax.period.v1',
    label: 'Tax expense for a period',
    owner: 'gl/accountClassification#aggregateFigures',
    includes:
      'Posted movement on expense accounts whose SUBTYPE canonicalises to tax_expense. Brightsphere carries R158,412.82 for FY2026 and R365,035.42 all-time.',
    excludes:
      'VAT, which is not an expense and is never in an income statement — see vat.output.v1 / vat.input.v1. Also excludes operating expenses; Since the B75 convergence getIncomeStatement agrees: tax bands to other_expense and is reported below the operating line on both surfaces. ' + COVERAGE_CAVEAT,
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
      'reports/incomeStatementService#getIncomeStatement reported P&L for the same accounts through a different classification layer before the B75 convergence; it now shares this one',
    ],
  }),
  'ppe.register.v1': def({
    id: 'ppe.register.v1',
    label: 'Property, plant and equipment per the fixed asset register',
    owner: 'items/assetRegisterService#getAssetRegister',
    includes:
      'Every asset in the assets table acquired on or before the reporting date and still HELD at it, at purchase_price less accumulated_depreciation. The figures are whatever was last written to the assets table.',
    excludes:
      'Assets disposed on or before the reporting date — they are not carrying amount and are reported separately as excludedRows, never dropped. Assets acquired after it. And the ledger: nothing here is derived from a journal, so this figure cannot corroborate itself. It is only as current as the last depreciation run, and on production NO asset carries a gl_asset_account_id, so no part of it can be attributed to a GL account.',
  }),
  'ppe.ledger.v1': def({
    id: 'ppe.ledger.v1',
    label: 'Property, plant and equipment per the general ledger',
    owner: 'items/fixedAssetReconciliationQueries#loadAssetSectionAccounts',
    includes:
      'Posted GL balance of every account of subtype fixed_assets or accumulated_depreciation as at the reporting date, INCLUDING deactivated accounts — is_active is a picker flag, not a statement about whether an account holds money.',
    excludes:
      'Draft journals. Accounts with no subtype: Velocity Fibre carries six accumulated-depreciation and depreciation accounts whose account_subtype is NULL, and they are invisible to this figure by construction. Nothing is excluded by NAME. Note that the subtype does not make an account property, plant and equipment: on Brightsphere thirteen accounts subtyped fixed_assets carry balances and every one is a loan or an investment, R8,458,079.49 of them on the credit side. reconcile_fixed_assets reports each account individually and flags the ones whose balance sign contradicts the subtype, precisely because this total on its own is misleading.',
    // Deliberately a SEPARATE figure from ppe.register.v1 and never merged: the
    // gap between them is the only thing that can detect the break, exactly as
    // for ar.subledger.v1 vs ar.control.v1.
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
  'gl.reclassification.v1': def({
    id: 'gl.reclassification.v1',
    label: 'Effect of moving posted amounts between two GL accounts',
    owner: 'gl/reclassification/impact#computeReclassImpact',
    includes:
      'TWO full aggregations over the same posted-ledger window: the accounts as they stand, and the same scan with the moved lines projected onto the target account. Both are folded by gl/accountClassification#aggregateFigures, the one owned classifier, so the before side is the same P&L profit_and_loss reports.',
    excludes:
      'Draft journals. And note the limit of the self-check: the before side is compared band by band against financialFiguresService and a disagreement is reported as a basis_disagreement warning — that is NECESSARY AND NOT SUFFICIENT. It proves this query has not drifted from the owning service; it cannot prove the PROJECTION is right, because nothing independent computes the after side. Read the journals, not only the delta.',
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
