/**
 * CaseWare Export Service — WS-7.3
 * Exports trial balance in CaseWare CSV format with configurable account mappings.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { escapeCsv } from '@/lib/csv';

type Row = Record<string, unknown>;

export interface AccountMapping {
  glAccountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  externalCode: string;
  externalLabel: string;
}

// ── CaseWare code suggestions ─────────────────────────────────────────────────

const CASEWARE_SUGGESTIONS: Record<string, { code: string; label: string }> = {
  'asset:bank':          { code: 'B10', label: 'Cash and cash equivalents' },
  'asset:cash':          { code: 'B10', label: 'Cash and cash equivalents' },
  'asset:petty_cash':    { code: 'B10', label: 'Cash and cash equivalents' },
  'asset:current_asset': { code: 'B20', label: 'Trade receivables' },
  'asset:receivable':    { code: 'B20', label: 'Trade receivables' },
  'asset:inventory':     { code: 'B30', label: 'Inventories' },
  'asset:fixed_asset':   { code: 'B40', label: 'Property, plant and equipment' },
  'asset:':              { code: 'B90', label: 'Other assets' },
  'liability:payable':   { code: 'C10', label: 'Trade payables' },
  'liability:tax_payable': { code: 'C20', label: 'Tax payable' },
  'liability:vat_output': { code: 'C20', label: 'Tax payable' },
  'liability:loan':      { code: 'C30', label: 'Borrowings' },
  'liability:':          { code: 'C90', label: 'Other liabilities' },
  'equity:':             { code: 'D10', label: 'Share capital' },
  'equity:retained':     { code: 'D20', label: 'Retained earnings' },
  'revenue:':            { code: 'E10', label: 'Revenue' },
  'expense:cost_of_sales': { code: 'F05', label: 'Cost of sales' },
  'expense:':            { code: 'F10', label: 'Operating expenses' },
};

export async function suggestCaseWareCode(
  accountType: string,
  accountSubtype: string | null,
): Promise<{ code: string; label: string }> {
  const specificKey = `${accountType}:${accountSubtype ?? ''}`;
  const genericKey = `${accountType}:`;
  return (
    CASEWARE_SUGGESTIONS[specificKey] ??
    CASEWARE_SUGGESTIONS[genericKey] ??
    { code: 'Z99', label: 'Unclassified' }
  );
}

// ── Get account mappings ──────────────────────────────────────────────────────

export async function getAccountMappings(
  companyId: string,
  targetSystem: string,
): Promise<AccountMapping[]> {
  const rows = await sql`
    SELECT
      ga.id AS gl_account_id,
      ga.account_code,
      ga.account_name,
      ga.account_type,
      ga.account_subtype,
      COALESCE(aem.external_code, '') AS external_code,
      COALESCE(aem.external_label, '') AS external_label
    FROM gl_accounts ga
    LEFT JOIN account_external_mapping aem
      ON aem.gl_account_id = ga.id
      AND aem.company_id = ${companyId}
      AND aem.target_system = ${targetSystem}
    WHERE ga.company_id = ${companyId}
      AND ga.is_active = true
    ORDER BY ga.account_code ASC
  ` as Row[];

  return rows.map((r: Row) => ({
    glAccountId: String(r.gl_account_id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    accountSubtype: r.account_subtype != null ? String(r.account_subtype) : null,
    externalCode: r.external_code != null ? String(r.external_code) : '',
    externalLabel: r.external_label != null ? String(r.external_label) : '',
  }));
}

// ── Save account mapping ──────────────────────────────────────────────────────

export async function saveAccountMapping(
  companyId: string,
  glAccountId: string,
  targetSystem: string,
  externalCode: string,
  externalLabel?: string,
): Promise<void> {
  log.info('Saving account mapping', { companyId, glAccountId, targetSystem, externalCode }, 'casewareExportService');

  await sql`
    INSERT INTO account_external_mapping (company_id, gl_account_id, target_system, external_code, external_label)
    VALUES (${companyId}, ${glAccountId}, ${targetSystem}, ${externalCode}, ${externalLabel ?? ''})
    ON CONFLICT (company_id, gl_account_id, target_system)
    DO UPDATE SET external_code = EXCLUDED.external_code, external_label = EXCLUDED.external_label
  `;
}

// ── Export trial balance as CaseWare CSV ──────────────────────────────────────

export async function exportCaseWareTB(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<string> {
  log.info('Exporting CaseWare trial balance', { companyId, periodStart, periodEnd }, 'casewareExportService');

  const rows = await sql`
    SELECT
      ga.account_code AS "AccountCode",
      ga.account_name AS "AccountName",
      ga.account_type AS "AccountType",
      ga.account_subtype AS "AccountSubtype",
      COALESCE(SUM(gjl.debit_amount), 0) AS debit,
      COALESCE(SUM(gjl.credit_amount), 0) AS credit,
      COALESCE(aem.external_code, '') AS "CaseWareCode",
      COALESCE(aem.external_label, '') AS "CaseWareLabel"
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines gjl ON gjl.account_id = ga.id
      AND gjl.company_id = ${companyId}
    LEFT JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      AND gje.entry_date BETWEEN ${periodStart} AND ${periodEnd}
      AND gje.status = 'posted'
    LEFT JOIN account_external_mapping aem
      ON aem.gl_account_id = ga.id
      AND aem.company_id = ${companyId}
      AND aem.target_system = 'caseware'
    WHERE ga.company_id = ${companyId}
      AND ga.is_active = true
    GROUP BY ga.account_code, ga.account_name, ga.account_type, ga.account_subtype,
             aem.external_code, aem.external_label
    HAVING COALESCE(SUM(gjl.debit_amount), 0) != 0 OR COALESCE(SUM(gjl.credit_amount), 0) != 0
    ORDER BY ga.account_code
  ` as Row[];

  const header = ['AccountCode', 'AccountName', 'Debit', 'Credit', 'NetBalance', 'CaseWareCode', 'CaseWareLabel'];
  const csvLines = [header.join(',')];

  for (const r of rows) {
    const debit = Number(r.debit) || 0;
    const credit = Number(r.credit) || 0;
    const net = debit - credit;
    csvLines.push([
      escapeCsv(String(r.AccountCode ?? '')),
      escapeCsv(String(r.AccountName ?? '')),
      debit.toFixed(2),
      credit.toFixed(2),
      net.toFixed(2),
      escapeCsv(String(r.CaseWareCode ?? '')),
      escapeCsv(String(r.CaseWareLabel ?? '')),
    ].join(','));
  }

  return csvLines.join('\r\n');
}

// ── Auto-suggest all codes for company ────────────────────────────────────────

export async function autoSuggestAllMappings(
  companyId: string,
): Promise<Array<{ glAccountId: string; code: string; label: string }>> {
  const rows = await sql`
    SELECT id, account_type, account_subtype
    FROM gl_accounts
    WHERE company_id = ${companyId} AND is_active = true
  ` as Row[];

  return rows.map((r: Row) => {
    const suggestion = CASEWARE_SUGGESTIONS[`${r.account_type}:${r.account_subtype ?? ''}`]
      ?? CASEWARE_SUGGESTIONS[`${r.account_type}:`]
      ?? { code: 'Z99', label: 'Unclassified' };
    return { glAccountId: String(r.id), code: suggestion.code, label: suggestion.label };
  });
}
