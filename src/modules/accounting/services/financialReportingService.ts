/**
 * PRD-060: FibreFlow Accounting Module — Phase 5
 * Financial Reporting Service
 *
 * Income Statement, Balance Sheet, VAT Return, Project Profitability
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  IncomeStatementReport,
  BalanceSheetReport,
  VATReturnReport,
  ProjectProfitabilityReport,
} from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

interface ReportLineItem {
  accountCode: string;
  accountName: string;
  amount: number;
}

interface BSLineItem {
  accountCode: string;
  accountName: string;
  balance: number;
}

// ── Income Statement (P&L) ───────────────────────────────────────────────────

interface ISOptions {
  projectId?: string;
  costCentreId?: string;
}

/** Fetch P&L line items for a single period. Reused for comparative calls. */
async function fetchIncomeStatementRows(
  periodStart: string,
  periodEnd: string,
  opts: ISOptions
) {
  const projId = opts.projectId ?? null;
  const ccId = opts.costCentreId ?? null;

  const rows = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, ga.account_subtype,
      COALESCE(SUM(jl.debit), 0) AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.entry_date >= ${periodStart}
      AND je.entry_date <= ${periodEnd}
      AND ga.account_type IN ('revenue', 'expense')
      AND (${projId}::TEXT IS NULL OR jl.project_id = ${projId}::UUID)
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype
    ORDER BY ga.account_code
  `) as Row[];

  const revenue: ReportLineItem[] = [];
  const costOfSales: ReportLineItem[] = [];
  const operatingExpenses: ReportLineItem[] = [];

  for (const r of rows) {
    const type = String(r.account_type);
    const subtype = r.account_subtype ? String(r.account_subtype) : '';
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);

    if (type === 'revenue') {
      const amount = credit - debit;
      if (Math.abs(amount) > 0.001) {
        revenue.push({ accountCode: String(r.account_code), accountName: String(r.account_name), amount });
      }
    } else if (type === 'expense') {
      const amount = debit - credit;
      if (Math.abs(amount) > 0.001) {
        const item = { accountCode: String(r.account_code), accountName: String(r.account_name), amount };
        if (subtype === 'cost_of_sales') costOfSales.push(item);
        else operatingExpenses.push(item);
      }
    }
  }

  const totalRevenue = revenue.reduce((s, i) => s + i.amount, 0);
  const totalCostOfSales = costOfSales.reduce((s, i) => s + i.amount, 0);
  const grossProfit = totalRevenue - totalCostOfSales;
  const totalOperatingExpenses = operatingExpenses.reduce((s, i) => s + i.amount, 0);
  const netProfit = grossProfit - totalOperatingExpenses;

  return { revenue, costOfSales, operatingExpenses, totalRevenue, totalCostOfSales, grossProfit, totalOperatingExpenses, netProfit };
}

export async function getIncomeStatement(
  periodStart: string,
  periodEnd: string,
  opts: ISOptions = {},
  comparePeriod?: { start: string; end: string }
): Promise<IncomeStatementReport> {
  try {
    const current = await fetchIncomeStatementRows(periodStart, periodEnd, opts);

    const report: IncomeStatementReport = {
      periodStart,
      periodEnd,
      projectId: opts.projectId,
      costCentreId: opts.costCentreId,
      revenue: current.revenue,
      costOfSales: current.costOfSales,
      operatingExpenses: current.operatingExpenses,
      totalRevenue: current.totalRevenue,
      totalCostOfSales: current.totalCostOfSales,
      grossProfit: current.grossProfit,
      totalOperatingExpenses: current.totalOperatingExpenses,
      netProfit: current.netProfit,
    };

    if (comparePeriod) {
      const prior = await fetchIncomeStatementRows(comparePeriod.start, comparePeriod.end, opts);
      report.comparativePeriod = comparePeriod;
      report.priorTotalRevenue = prior.totalRevenue;
      report.priorTotalCostOfSales = prior.totalCostOfSales;
      report.priorGrossProfit = prior.grossProfit;
      report.priorTotalOperatingExpenses = prior.totalOperatingExpenses;
      report.priorNetProfit = prior.netProfit;

      const mergeLineItems = (curr: ReportLineItem[], prev: ReportLineItem[]) => {
        const priorMap = new Map(prev.map(p => [p.accountCode, p.amount]));
        return curr.map(c => {
          const pa = priorMap.get(c.accountCode) ?? 0;
          const variance = c.amount - pa;
          return { ...c, priorAmount: pa, variance, variancePct: pa !== 0 ? (variance / Math.abs(pa)) * 100 : 0 };
        });
      };
      report.revenue = mergeLineItems(current.revenue, prior.revenue);
      report.costOfSales = mergeLineItems(current.costOfSales, prior.costOfSales);
      report.operatingExpenses = mergeLineItems(current.operatingExpenses, prior.operatingExpenses);
    }

    return report;
  } catch (err) {
    log.error('Failed to generate income statement', { error: err }, 'accounting');
    throw err;
  }
}

// ── Balance Sheet ────────────────────────────────────────────────────────────

/** Fetch balance sheet data for a single date. Reused for comparative calls. */
async function fetchBalanceSheetData(asAtDate: string, costCentreId?: string) {
  const ccId = costCentreId ?? null;

  const rows = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
      COALESCE(SUM(jl.debit), 0) AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.entry_date <= ${asAtDate}
      AND ga.account_type IN ('asset', 'liability', 'equity')
      AND ga.level >= 3
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
    GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance
    ORDER BY ga.account_code
  `) as Row[];

  const assets: BSLineItem[] = [];
  const liabilities: BSLineItem[] = [];
  const equity: BSLineItem[] = [];

  for (const r of rows) {
    const type = String(r.account_type);
    const normalBal = String(r.normal_balance);
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    const balance = normalBal === 'debit' ? debit - credit : credit - debit;
    if (Math.abs(balance) < 0.01) continue;

    const item: BSLineItem = { accountCode: String(r.account_code), accountName: String(r.account_name), balance };
    if (type === 'asset') assets.push(item);
    else if (type === 'liability') liabilities.push(item);
    else if (type === 'equity') equity.push(item);
  }

  const retainedEarnings = await calculateRetainedEarnings(asAtDate, costCentreId);
  if (Math.abs(retainedEarnings) > 0.01) {
    const existing = equity.find(e => e.accountCode === '3200');
    if (existing) existing.balance += retainedEarnings;
    else equity.push({ accountCode: '3200', accountName: 'Retained Earnings (Current)', balance: retainedEarnings });
  }

  return { assets, liabilities, equity };
}

export async function getBalanceSheet(
  asAtDate: string,
  costCentreId?: string,
  compareDate?: string
): Promise<BalanceSheetReport> {
  try {
    const current = await fetchBalanceSheetData(asAtDate, costCentreId);

    const report: BalanceSheetReport = {
      asAtDate,
      costCentreId,
      assets: current.assets,
      liabilities: current.liabilities,
      equity: current.equity,
      totalAssets: current.assets.reduce((s, a) => s + a.balance, 0),
      totalLiabilities: current.liabilities.reduce((s, l) => s + l.balance, 0),
      totalEquity: current.equity.reduce((s, e) => s + e.balance, 0),
    };

    if (compareDate) {
      const prior = await fetchBalanceSheetData(compareDate, costCentreId);
      report.compareDate = compareDate;
      report.priorTotalAssets = prior.assets.reduce((s, a) => s + a.balance, 0);
      report.priorTotalLiabilities = prior.liabilities.reduce((s, l) => s + l.balance, 0);
      report.priorTotalEquity = prior.equity.reduce((s, e) => s + e.balance, 0);

      const mergeBSLines = (curr: BSLineItem[], prev: BSLineItem[]) => {
        const priorMap = new Map(prev.map(p => [p.accountCode, p.balance]));
        return curr.map(c => {
          const pb = priorMap.get(c.accountCode) ?? 0;
          const variance = c.balance - pb;
          return { ...c, priorBalance: pb, variance, variancePct: pb !== 0 ? (variance / Math.abs(pb)) * 100 : 0 };
        });
      };
      report.assets = mergeBSLines(current.assets, prior.assets);
      report.liabilities = mergeBSLines(current.liabilities, prior.liabilities);
      report.equity = mergeBSLines(current.equity, prior.equity);
    }

    return report;
  } catch (err) {
    log.error('Failed to generate balance sheet', { error: err }, 'accounting');
    throw err;
  }
}

async function calculateRetainedEarnings(asAtDate: string, costCentreId?: string): Promise<number> {
  const ccId = costCentreId ?? null;
  const rows = (await sql`
    SELECT
      COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
      COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expenses
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.entry_date <= ${asAtDate}
      AND ga.account_type IN ('revenue', 'expense')
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
  `) as Row[];

  return Number(rows[0]!.revenue) - Number(rows[0]!.expenses);
}

// ── VAT201 Return (SA SARS) ─────────────────────────────────────────────────

interface VAT201BoxDef {
  box: string;
  label: string;
  accountType: 'liability' | 'asset';
  vatTypes: string[];
}

const OUTPUT_BOXES: VAT201BoxDef[] = [
  { box: '1',   label: 'Standard rated supplies',           accountType: 'liability', vatTypes: ['standard'] },
  { box: '1A',  label: 'Capital goods/services supplied',   accountType: 'liability', vatTypes: ['capital_goods'] },
  { box: '2',   label: 'Zero-rated supplies (domestic)',    accountType: 'liability', vatTypes: ['zero_rated'] },
  { box: '2A',  label: 'Zero-rated exports',                accountType: 'liability', vatTypes: ['export'] },
  { box: '3',   label: 'Exempt supplies',                   accountType: 'liability', vatTypes: ['exempt'] },
  { box: '12',  label: 'Imported services / other output',  accountType: 'liability', vatTypes: ['reverse_charge', 'imported'] },
];

const INPUT_BOXES: VAT201BoxDef[] = [
  { box: '14',      label: 'Capital goods/services purchased', accountType: 'asset', vatTypes: ['capital_goods'] },
  { box: '15',      label: 'Other goods/services purchased',   accountType: 'asset', vatTypes: ['standard'] },
  { box: '14A/15A', label: 'Goods imported',                   accountType: 'asset', vatTypes: ['imported'] },
  { box: '16',      label: 'Change in use',                    accountType: 'asset', vatTypes: ['reverse_charge'] },
  { box: '17',      label: 'Bad debts',                        accountType: 'asset', vatTypes: ['bad_debt'] },
  { box: '18',      label: 'Other adjustments',                accountType: 'asset', vatTypes: ['exempt', 'no_vat'] },
];

/** Line-level transaction shape used in drill-down arrays. */
interface VATDrillDown {
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  description: string;
  sourceDocument?: string;
  amount: number;
}

/** Populated VAT201 box with transactions list. */
interface PopulatedBox {
  box: string;
  label: string;
  amount: number;
  transactions: VATDrillDown[];
}

export async function getVATReturn(
  periodStart: string,
  periodEnd: string
): Promise<VATReturnReport> {
  try {
    // Fetch every posted journal line that touches a VAT-control account within the
    // period. Two account codes are targeted: 2120 (Output VAT liability) and 1140
    // (Input VAT asset). The account_subtype = 'tax' guard catches any additional
    // tax sub-ledger accounts the chart of accounts may define in the future.
    const vatLines = (await sql`
      SELECT
        jl.id              AS line_id,
        jl.gl_account_id,
        jl.debit,
        jl.credit,
        jl.vat_type,
        jl.description     AS line_description,
        je.id              AS journal_entry_id,
        je.entry_number,
        je.entry_date,
        je.description     AS entry_description,
        je.source_document_id,
        ga.account_code,
        ga.account_name,
        ga.account_type
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga        ON ga.id  = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND (
          ga.account_code IN ('1140', '2120')
          OR ga.account_subtype = 'tax'
        )
      ORDER BY je.entry_date, je.entry_number
    `) as Row[];

    /** Build a drill-down transaction object from a raw journal line. */
    const toDrillDown = (l: Row, signFn: (debit: number, credit: number) => number): VATDrillDown => ({
      journalEntryId: String(l.journal_entry_id),
      entryNumber:    String(l.entry_number),
      entryDate:      String(l.entry_date),
      description:    l.entry_description
        ? String(l.entry_description)
        : l.line_description
          ? String(l.line_description)
          : '',
      sourceDocument: l.source_document_id ? String(l.source_document_id) : undefined,
      amount: signFn(Number(l.debit), Number(l.credit)),
    });

    // ── Output Boxes ────────────────────────────────────────────────────────
    const outputBoxes: PopulatedBox[] = OUTPUT_BOXES.map((boxDef) => {
      const matching = vatLines.filter((l: Row) => {
        const isOutput =
          String(l.account_type) === 'liability' ||
          String(l.account_code) === '2120';
        const matchesType =
          l.vat_type != null && boxDef.vatTypes.includes(String(l.vat_type));
        return isOutput && matchesType;
      });

      // Output VAT: credit increases the liability; net = credit - debit.
      const transactions = matching.map((l: Row) =>
        toDrillDown(l, (d, c) => c - d)
      );
      const amount = transactions.reduce((s, t) => s + t.amount, 0);
      return { box: boxDef.box, label: boxDef.label, amount, transactions };
    });

    // Unclassified output lines (vat_type IS NULL) default to Box 1 — standard.
    const unclassifiedOutput = vatLines.filter((l: Row) => {
      const isOutput =
        String(l.account_type) === 'liability' ||
        String(l.account_code) === '2120';
      return isOutput && l.vat_type == null;
    });
    if (unclassifiedOutput.length > 0) {
      const box1 = outputBoxes.find((b) => b.box === '1');
      if (box1) {
        const extra = unclassifiedOutput.map((l: Row) =>
          toDrillDown(l, (d, c) => c - d)
        );
        box1.amount += extra.reduce((s, t) => s + t.amount, 0);
        box1.transactions.push(...extra);
      }
    }

    // ── Input Boxes ──────────────────────────────────────────────────────────
    const inputBoxes: PopulatedBox[] = INPUT_BOXES.map((boxDef) => {
      const matching = vatLines.filter((l: Row) => {
        const isInput =
          String(l.account_type) === 'asset' ||
          String(l.account_code) === '1140';
        const matchesType =
          l.vat_type != null && boxDef.vatTypes.includes(String(l.vat_type));
        return isInput && matchesType;
      });

      // Input VAT: debit increases the asset; net = debit - credit.
      const transactions = matching.map((l: Row) =>
        toDrillDown(l, (d, c) => d - c)
      );
      const amount = transactions.reduce((s, t) => s + t.amount, 0);
      return { box: boxDef.box, label: boxDef.label, amount, transactions };
    });

    // Unclassified input lines (vat_type IS NULL) default to Box 15 — standard purchases.
    const unclassifiedInput = vatLines.filter((l: Row) => {
      const isInput =
        String(l.account_type) === 'asset' ||
        String(l.account_code) === '1140';
      return isInput && l.vat_type == null;
    });
    if (unclassifiedInput.length > 0) {
      const box15 = inputBoxes.find((b) => b.box === '15');
      if (box15) {
        const extra = unclassifiedInput.map((l: Row) =>
          toDrillDown(l, (d, c) => d - c)
        );
        box15.amount += extra.reduce((s, t) => s + t.amount, 0);
        box15.transactions.push(...extra);
      }
    }

    // ── Totals ───────────────────────────────────────────────────────────────
    const totalOutputTax = outputBoxes.reduce((s, b) => s + b.amount, 0);
    const totalInputTax  = inputBoxes.reduce((s, b) => s + b.amount, 0);
    const netVAT         = totalOutputTax - totalInputTax;

    // Legacy compatibility fields — summarise non-zero boxes as account-like lines.
    const outputDetails = outputBoxes
      .filter((b) => Math.abs(b.amount) > 0.001)
      .map((b) => ({ accountCode: b.box, accountName: b.label, amount: b.amount }));
    const inputDetails = inputBoxes
      .filter((b) => Math.abs(b.amount) > 0.001)
      .map((b) => ({ accountCode: b.box, accountName: b.label, amount: b.amount }));

    return {
      periodStart,
      periodEnd,
      outputBoxes,
      totalOutputTax,
      inputBoxes,
      totalInputTax,
      netVAT,
      outputVAT: totalOutputTax,
      inputVAT:  totalInputTax,
      outputDetails,
      inputDetails,
    };
  } catch (err) {
    log.error('Failed to generate VAT return', { error: err }, 'accounting');
    throw err;
  }
}

// ── Project Profitability ────────────────────────────────────────────────────

export async function getProjectProfitability(
  periodStart: string,
  periodEnd: string
): Promise<ProjectProfitabilityReport[]> {
  try {
    // Get all projects with journal activity in the period
    const projectRows = (await sql`
      SELECT DISTINCT jl.project_id, p.project_name
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      LEFT JOIN projects p ON p.id = jl.project_id
      WHERE je.status = 'posted'
        AND je.entry_date >= ${periodStart}
        AND je.entry_date <= ${periodEnd}
        AND jl.project_id IS NOT NULL
      ORDER BY p.project_name
    `) as Row[];

    const reports: ProjectProfitabilityReport[] = [];

    for (const proj of projectRows) {
      const projectId = String(proj.project_id);
      const projectName = proj.project_name ? String(proj.project_name) : 'Unknown Project';

      const rows = (await sql`
        SELECT ga.account_code, ga.account_name, ga.account_type,
          COALESCE(SUM(jl.debit), 0) AS total_debit,
          COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.entry_date >= ${periodStart}
          AND je.entry_date <= ${periodEnd}
          AND jl.project_id = ${projectId}::UUID
          AND ga.account_type IN ('revenue', 'expense')
        GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type
        ORDER BY ga.account_code
      `) as Row[];

      const revenueLines: ReportLineItem[] = [];
      const costLines: ReportLineItem[] = [];

      for (const r of rows) {
        const type = String(r.account_type);
        const debit = Number(r.total_debit);
        const credit = Number(r.total_credit);

        if (type === 'revenue') {
          const amount = credit - debit;
          if (Math.abs(amount) > 0.001) {
            revenueLines.push({ accountCode: String(r.account_code), accountName: String(r.account_name), amount });
          }
        } else if (type === 'expense') {
          const amount = debit - credit;
          if (Math.abs(amount) > 0.001) {
            costLines.push({ accountCode: String(r.account_code), accountName: String(r.account_name), amount });
          }
        }
      }

      const revenue = revenueLines.reduce((s, r) => s + r.amount, 0);
      const costs = costLines.reduce((s, c) => s + c.amount, 0);
      const profit = revenue - costs;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

      reports.push({
        projectId,
        projectName,
        periodStart,
        periodEnd,
        revenue,
        costs,
        profit,
        margin: Math.round(margin * 100) / 100,
        revenueLines,
        costLines,
      });
    }

    // Sort by profit DESC
    reports.sort((a, b) => b.profit - a.profit);
    return reports;
  } catch (err) {
    log.error('Failed to generate project profitability', { error: err }, 'accounting');
    throw err;
  }
}
