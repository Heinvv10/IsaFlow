// src/modules/accounting/services/afs/noteGenerators/notes1to10.ts
// AFS Note Engine — generators for Notes 1–10

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fiscalRange(year: number): { start: string; end: string } {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function toNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

type NoteResult = { dataSnapshot: Record<string, unknown>; content: NoteContent };

// ── Note 1 — Accounting Policies ─────────────────────────────────────────────

export async function generateNote1AccountingPolicies(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const rows = (await sql`
    SELECT depreciation_method, inventory_valuation_method, default_currency, vat_system_type
    FROM companies WHERE id = ${companyId}
  `) as DbRow[];

  const c = rows[0] ?? {};
  const depMethod = String(c.depreciation_method ?? 'straight-line');
  const invMethod = String(c.inventory_valuation_method ?? 'weighted average cost');
  const currency = String(c.default_currency ?? 'ZAR');
  const vatType = String(c.vat_system_type ?? 'invoice');

  const dataSnapshot: Record<string, unknown> = {
    depreciation_method: depMethod,
    inventory_valuation_method: invMethod,
    default_currency: currency,
    vat_system_type: vatType,
    fiscal_year: fiscalYear,
  };

  const text =
    `These financial statements have been prepared in accordance with the International Financial ` +
    `Reporting Standard for Small and Medium-sized Entities (IFRS for SMEs) and the Companies Act ` +
    `71 of 2008. The financial statements are presented in ${currency} and rounded to the nearest Rand. ` +
    `Basis of preparation: The financial statements are prepared under the historical cost convention. ` +
    `Property, plant and equipment (PPE): PPE is measured at cost less accumulated depreciation. ` +
    `Depreciation is calculated using the ${depMethod} method over the estimated useful lives of the assets. ` +
    `Inventories: Inventories are measured at the lower of cost and estimated selling price less costs ` +
    `to complete and sell. Cost is determined using the ${invMethod} method. ` +
    `Revenue recognition: Revenue from the sale of goods is recognised when the significant risks and ` +
    `rewards of ownership have transferred to the buyer. Revenue from services is recognised by reference ` +
    `to the stage of completion. ` +
    `Taxation: Current tax is measured at the amount expected to be paid to the tax authorities using ` +
    `tax rates enacted or substantively enacted at the reporting date. The entity accounts for VAT on ` +
    `the ${vatType} basis.`;

  const content: NoteContent = {
    title: 'Accounting Policies',
    blocks: [{ type: 'paragraph', text }],
  };

  return { dataSnapshot, content };
}

// ── Note 2 — Significant Estimates and Judgements ────────────────────────────

export async function generateNote2SignificantEstimates(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { start, end } = fiscalRange(fiscalYear);

  const rows = (await sql`
    SELECT ga.account_subtype, ga.account_name,
           SUM(gjl.debit - gjl.credit) AS net_balance
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id
      AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      AND gje.entry_date BETWEEN ${start} AND ${end}
      AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('provision', 'impairment', 'deferred_tax', 'depreciation')
    GROUP BY ga.account_subtype, ga.account_name
    ORDER BY ga.account_subtype
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { estimates: [], suppressReason: 'zero_balance' },
      content: {
        title: 'Significant Estimates and Judgements',
        blocks: [
          {
            type: 'paragraph',
            text: 'No significant accounting estimates or judgements have been identified for this period. [Accountant: complete this note if applicable]',
          },
        ],
      },
    };
  }

  const subtypes = [...new Set(rows.map((r) => String(r.account_subtype)))];

  const subtypeLabels: Record<string, string> = {
    provision: 'Provisions — management estimates the probability and amount of obligations that are probable and can be reliably measured.',
    impairment: 'Impairment of assets — management assesses at each reporting date whether there is an indication that an asset may be impaired.',
    deferred_tax: 'Deferred tax — management applies judgement in determining temporary differences and the recoverability of deferred tax assets.',
    depreciation: 'Useful lives and residual values — management regularly reviews the estimated useful lives and residual values of depreciable assets.',
  };

  const items = subtypes.map((s) => subtypeLabels[s] ?? `${s} — management applies judgement in estimating this balance.`);

  const content: NoteContent = {
    title: 'Significant Estimates and Judgements',
    blocks: [
      {
        type: 'paragraph',
        text: 'In applying the entity\'s accounting policies, management has made the following judgements and estimates that have the most significant effect on the amounts recognised in the financial statements:',
      },
      { type: 'list', items },
    ],
  };

  return { dataSnapshot: { estimates: rows }, content };
}

// ── Note 3 — Property, Plant and Equipment ────────────────────────────────────

export async function generateNote3PropertyPlantEquipment(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { start, end } = fiscalRange(fiscalYear);

  const rows = (await sql`
    SELECT a.category,
      SUM(a.purchase_price) AS total_cost,
      SUM(a.accumulated_depreciation) AS total_accum_dep,
      SUM(a.current_book_value) AS total_carrying_value,
      SUM(CASE WHEN a.purchase_date BETWEEN ${start} AND ${end} THEN a.purchase_price ELSE 0 END) AS additions,
      SUM(CASE WHEN a.disposal_date BETWEEN ${start} AND ${end} THEN a.purchase_price ELSE 0 END) AS disposals
    FROM assets a
    WHERE a.company_id = ${companyId}
      AND (a.disposal_date IS NULL OR a.disposal_date >= ${start}::DATE)
    GROUP BY a.category
    ORDER BY a.category
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { ppe: [], suppressReason: 'zero_balance' },
      content: {
        title: 'Property, Plant and Equipment',
        blocks: [
          {
            type: 'paragraph',
            text: 'No property, plant and equipment has been recorded for this period. [Accountant: complete this note if applicable]',
          },
        ],
      },
    };
  }

  const dataRows: string[][] = rows.map((r) => [
    String(r.category ?? ''),
    fmt(toNum(r.total_cost)),
    fmt(toNum(r.total_accum_dep)),
    fmt(toNum(r.total_carrying_value)),
    fmt(toNum(r.additions)),
    fmt(toNum(r.disposals)),
  ]);

  const totals = rows.reduce<{ cost: number; dep: number; cv: number; add: number; dis: number }>(
    (acc, r) => {
      acc.cost += toNum(r.total_cost);
      acc.dep += toNum(r.total_accum_dep);
      acc.cv += toNum(r.total_carrying_value);
      acc.add += toNum(r.additions);
      acc.dis += toNum(r.disposals);
      return acc;
    },
    { cost: 0, dep: 0, cv: 0, add: 0, dis: 0 },
  );

  dataRows.push(['Total', fmt(totals.cost), fmt(totals.dep), fmt(totals.cv), fmt(totals.add), fmt(totals.dis)]);

  const content: NoteContent = {
    title: 'Property, Plant and Equipment',
    blocks: [
      {
        type: 'paragraph',
        text: 'The following table summarises the carrying amounts and movements in property, plant and equipment for the year:',
      },
      {
        type: 'table',
        headers: ['Category', 'Cost', 'Accum Depr', 'Carrying Value', 'Additions', 'Disposals'],
        rows: dataRows,
      },
    ],
  };

  return { dataSnapshot: { ppe: rows }, content };
}

// ── Note 4 — Right-of-Use Assets ─────────────────────────────────────────────

export async function generateNote4RightOfUseAssets(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { rou: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Right-of-Use Assets',
    blocks: [
      {
        type: 'paragraph',
        text: 'Right-of-use assets under IFRS 16 have not been configured for this entity. [Accountant: complete this note if any leases exist]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 5 — Intangible Assets ────────────────────────────────────────────────

export async function generateNote5IntangibleAssets(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { intangibles: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Intangible Assets',
    blocks: [
      {
        type: 'paragraph',
        text: 'No intangible assets have been recorded. [Accountant: complete this note if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 6 — Investment Property ──────────────────────────────────────────────

export async function generateNote6InvestmentProperty(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { investmentProperty: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Investment Property',
    blocks: [
      {
        type: 'paragraph',
        text: 'No investment property has been recorded. [Accountant: complete this note if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 7 — Investments in Associates ───────────────────────────────────────

export async function generateNote7InvestmentsInAssociates(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { associates: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Investments in Associates',
    blocks: [
      {
        type: 'paragraph',
        text: 'No investments in associates have been recorded. [Accountant: complete this note if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 8 — Financial Assets ─────────────────────────────────────────────────

export async function generateNote8FinancialAssets(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { end } = fiscalRange(fiscalYear);

  const rows = (await sql`
    SELECT ga.account_name, ga.account_subtype,
           SUM(gjl.debit - gjl.credit) AS balance
    FROM gl_accounts ga
    JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id
      AND gjl.company_id = ${companyId}
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype IN ('investment', 'financial_asset', 'loan_receivable')
    GROUP BY ga.account_name, ga.account_subtype
    HAVING SUM(gjl.debit - gjl.credit) <> 0
    ORDER BY ga.account_subtype, ga.account_name
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { financialAssets: [], suppressReason: 'zero_balance' },
      content: {
        title: 'Financial Assets',
        blocks: [
          {
            type: 'paragraph',
            text: 'No financial assets have been recorded for this period. [Accountant: complete this note if applicable]',
          },
        ],
      },
    };
  }

  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(toNum(r.balance)),
  ]);

  const content: NoteContent = {
    title: 'Financial Assets',
    blocks: [
      {
        type: 'table',
        headers: ['Account', 'Classification', 'Balance'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot: { financialAssets: rows }, content };
}

// ── Note 9 — Inventories ──────────────────────────────────────────────────────

export async function generateNote9Inventories(
  _companyId: string,
  _fiscalYear: number,
): Promise<NoteResult> {
  const dataSnapshot = { inventory: [] as unknown[], suppressReason: 'table_not_implemented' };
  const content: NoteContent = {
    title: 'Inventories',
    blocks: [
      {
        type: 'paragraph',
        text: 'Inventory items have not been configured in the system. [Accountant: complete this note if applicable]',
      },
    ],
  };
  return { dataSnapshot, content };
}

// ── Note 10 — Trade and Other Receivables ─────────────────────────────────────

export async function generateNote10TradeReceivables(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { end } = fiscalRange(fiscalYear);

  const rows = (await sql`
    SELECT
      SUM(ci.total_amount) FILTER (WHERE ci.status NOT IN ('paid','cancelled','void')) AS gross_receivables,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE AND ci.due_date > ${end}::DATE - INTERVAL '30 days'
      ) AS current_amount,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE - INTERVAL '30 days'
          AND ci.due_date > ${end}::DATE - INTERVAL '60 days'
      ) AS days_30,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE - INTERVAL '60 days'
          AND ci.due_date > ${end}::DATE - INTERVAL '90 days'
      ) AS days_60,
      SUM(ci.total_amount) FILTER (
        WHERE ci.status NOT IN ('paid','cancelled','void')
          AND ci.due_date <= ${end}::DATE - INTERVAL '90 days'
      ) AS days_90_plus
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId} AND ci.invoice_date <= ${end}
  `) as DbRow[];

  const row = rows[0] ?? {};
  const gross = toNum(row.gross_receivables);
  const current = toNum(row.current_amount);
  const d30 = toNum(row.days_30);
  const d60 = toNum(row.days_60);
  const d90plus = toNum(row.days_90_plus);
  const agingTotal = current + d30 + d60 + d90plus;

  const summaryTable = {
    type: 'table' as const,
    headers: ['', 'Amount (R)'],
    rows: [
      ['Gross trade receivables', fmt(gross)],
      ['Less: Provision for doubtful debts', fmt(0)],
      ['Net trade receivables', fmt(gross)],
    ],
  };

  const agingTable = {
    type: 'table' as const,
    headers: ['Current', '30 days', '60 days', '90+ days', 'Total'],
    rows: [[fmt(current), fmt(d30), fmt(d60), fmt(d90plus), fmt(agingTotal)]],
  };

  const content: NoteContent = {
    title: 'Trade and Other Receivables',
    blocks: [summaryTable, agingTable],
  };

  return { dataSnapshot: { receivables: rows }, content };
}
