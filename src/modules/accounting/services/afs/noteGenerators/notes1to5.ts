// src/modules/accounting/services/afs/noteGenerators/notes1to5.ts
// AFS Note Engine — generators for Notes 1–5

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { fmt, toNum, getAccountingPolicies, type FrameworkType } from './noteHelpers';
import { isVatRegistered, normalizeVatBasis } from '@/modules/bureau/services/vatPeriodHelper';
import { getFiscalRange } from '@/modules/accounting/services/afs/afsFiscalPeriod';
import { rawSubtypesFor } from '@/modules/accounting/services/gl/accountSubtypes';

type NoteResult = { dataSnapshot: Record<string, unknown>; content: NoteContent };

// ── Note 1 — Accounting Policies ─────────────────────────────────────────────

export async function generateNote1AccountingPolicies(
  companyId: string,
  fiscalYear: number,
  framework?: FrameworkType,
): Promise<NoteResult> {
  log.info('Generating AFS note 1', { companyId, framework }, 'noteGenerators');

  const rows = (await sql`
    SELECT depreciation_method, inventory_valuation_method, default_currency,
           vat_system_type, vat_period
    FROM companies WHERE id = ${companyId}
  `) as DbRow[];

  const c = rows[0] ?? {};
  const depMethod = String(c.depreciation_method ?? 'straight-line');
  const invMethod = String(c.inventory_valuation_method ?? 'weighted average cost');
  const currency = String(c.default_currency ?? 'ZAR');
  // vat_period/vat_system_type = 'none' means the company is not a VAT vendor;
  // both columns must go through the normalisers (see vatPeriodHelper).
  const vatRegistered = isVatRegistered(
    c.vat_period == null ? null : String(c.vat_period),
    c.vat_system_type == null ? null : String(c.vat_system_type),
  );
  const vatType = normalizeVatBasis(c.vat_system_type == null ? null : String(c.vat_system_type));
  const fw: FrameworkType = framework ?? 'ifrs_smes';

  const dataSnapshot: Record<string, unknown> = {
    depreciation_method: depMethod,
    inventory_valuation_method: invMethod,
    default_currency: currency,
    vat_system_type: vatRegistered ? vatType : 'none',
    vat_registered: vatRegistered,
    fiscal_year: fiscalYear,
    framework: fw,
  };

  // Get framework-aware accounting policy paragraphs
  const policyBlocks = getAccountingPolicies(fw, {
    depMethod,
    invMethod,
    currency,
    vatBasis: vatType,
    vatRegistered,
  });

  const blocks: NoteContent['blocks'] = [];
  for (const p of policyBlocks) {
    blocks.push({ type: 'heading', text: p.heading, level: 3 });
    blocks.push({ type: 'paragraph', text: p.text });
  }

  const content: NoteContent = {
    title: 'Accounting Policies',
    blocks,
  };

  return { dataSnapshot, content };
}

// ── Note 2 — Significant Estimates and Judgements ────────────────────────────

export async function generateNote2SignificantEstimates(
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  log.info('Generating AFS note 2', { companyId }, 'noteGenerators');

  const { start, end } = await getFiscalRange(companyId, fiscalYear);

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
      -- 'depreciation' alone missed depreciation_expense/amortisation/amortization.
      AND ga.account_subtype = ANY(${['provision', 'impairment', 'deferred_tax',
        ...rawSubtypesFor('depreciation_expense')]}::TEXT[])
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
  log.info('Generating AFS note 3', { companyId }, 'noteGenerators');

  const { start, end } = await getFiscalRange(companyId, fiscalYear);

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
  companyId: string,
  fiscalYear: number,
): Promise<NoteResult> {
  const { end } = await getFiscalRange(companyId, fiscalYear);

  log.info('Generating AFS note 5 — intangible assets', { companyId, fiscalYear }, 'noteGenerators');

  // Query GL accounts classified as intangible assets
  const rows = (await sql`
    SELECT ga.account_name, ga.account_code, ga.account_subtype,
           COALESCE(SUM(gjl.debit - gjl.credit), 0) AS balance
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines gjl
      ON gjl.gl_account_id = ga.id AND gjl.company_id = ${companyId}
    LEFT JOIN gl_journal_entries gje
      ON gje.id = gjl.journal_entry_id
      AND gje.entry_date <= ${end} AND gje.status = 'posted'
    WHERE ga.company_id = ${companyId}
      AND ga.account_subtype = ANY(${[...rawSubtypesFor('intangible_asset'),
        'goodwill', 'software', 'patent', 'trademark', 'licence']}::TEXT[])
    GROUP BY ga.account_name, ga.account_code, ga.account_subtype
    HAVING COALESCE(SUM(gjl.debit - gjl.credit), 0) <> 0
    ORDER BY ga.account_subtype, ga.account_name
  `) as DbRow[];

  if (rows.length === 0) {
    return {
      dataSnapshot: { intangibles: [], suppressReason: 'zero_balance' },
      content: {
        title: 'Intangible Assets',
        blocks: [
          {
            type: 'paragraph',
            text: 'No intangible assets have been recorded for this period. [Accountant: complete this note if applicable]',
          },
        ],
      },
    };
  }

  const total = rows.reduce((acc, r) => acc + toNum(r.balance), 0);
  const tableRows: string[][] = rows.map((r) => [
    String(r.account_name ?? ''),
    String(r.account_subtype ?? ''),
    fmt(toNum(r.balance)),
  ]);
  tableRows.push(['Total', '', fmt(total)]);

  const content: NoteContent = {
    title: 'Intangible Assets',
    blocks: [
      {
        type: 'paragraph',
        text: 'Intangible assets are carried at cost less accumulated amortisation and impairment losses. Amortisation is recognised on a straight-line basis over the estimated useful life.',
      },
      {
        type: 'table',
        headers: ['Asset', 'Classification', 'Carrying Value (R)'],
        rows: tableRows,
      },
    ],
  };

  return { dataSnapshot: { intangibles: rows }, content };
}
