/**
 * CaseWare Export Service — WS-7.3
 * Exports trial balance in CaseWare CSV format with configurable account mappings.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { escapeCsv } from '@/lib/csv';
import type { DbRow } from '@/types/db';
import {
  broughtForwardLine,
  getRetainedEarningsBroughtForward,
  round2,
  splitNet,
} from '../gl/trialBalanceBasis';


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
  ` as DbRow[];

  return rows.map((r: DbRow) => ({
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

interface CaseWareLine {
  accountCode: string;
  accountName: string;
  /** Net balance, debit-positive. */
  net: number;
  casewareCode: string;
  casewareLabel: string;
}

/**
 * INV-E1: this used to export the range's gross debit and credit TURNOVER for
 * every account, so a client's audit software received one period's movement
 * labelled as a trial balance — Brightsphere's Trade Debtors exported as
 * R128,800 against a balance of R8,551,948.60. Balance-sheet accounts are now
 * cumulative to `periodEnd`, income-statement accounts cover
 * `periodStart`..`periodEnd`, and the profit earned before `periodStart` is
 * reported against retained earnings so the export balances.
 *
 * Deactivated accounts are NOT excluded: `is_active` marks an account as closed
 * for new postings, not as empty. Brightsphere's "Loan Account - Blitz Fibre"
 * (1121) is inactive and still carries R130,000, and filtering it out left the
 * export out of balance by exactly that. The zero-balance filter below drops
 * dormant accounts on their balance, which is the correct test.
 *
 * NOTE: gl_journal_lines uses columns `debit` / `credit` and `gl_account_id` (not
 * `debit_amount` / `credit_amount` / `account_id`).  GROUP BY must include ga.id so
 * that duplicate account_codes (data issue) each get their own row rather than being
 * silently merged — callers can see the duplication and flag it for cleanup.
 */
export async function exportCaseWareTB(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<string> {
  log.info('Exporting CaseWare trial balance', { companyId, periodStart, periodEnd }, 'casewareExportService');

  const rows = await sql`
    SELECT
      ga.id AS ga_id,
      ga.account_code AS "AccountCode",
      ga.account_name AS "AccountName",
      COALESCE(SUM(CASE WHEN gje.id IS NULL THEN 0
                        WHEN ga.account_type IN ('asset', 'liability', 'equity')
                          OR gje.entry_date >= ${periodStart}
                        THEN gjl.debit ELSE 0 END), 0) AS debit,
      COALESCE(SUM(CASE WHEN gje.id IS NULL THEN 0
                        WHEN ga.account_type IN ('asset', 'liability', 'equity')
                          OR gje.entry_date >= ${periodStart}
                        THEN gjl.credit ELSE 0 END), 0) AS credit,
      COALESCE(aem.external_code, '') AS "CaseWareCode",
      COALESCE(aem.external_label, '') AS "CaseWareLabel"
    FROM gl_accounts ga
    LEFT JOIN gl_journal_lines gjl ON gjl.gl_account_id = ga.id
      AND gjl.company_id = ${companyId}
    LEFT JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
      AND gje.company_id = ${companyId}
      AND gje.status = 'posted'
      AND gje.entry_date <= ${periodEnd}
    LEFT JOIN account_external_mapping aem
      ON aem.gl_account_id = ga.id
      AND aem.company_id = ${companyId}
      AND aem.target_system = 'caseware'
    WHERE ga.company_id = ${companyId}
    GROUP BY ga.id, ga.account_code, ga.account_name,
             aem.external_code, aem.external_label
    ORDER BY ga.account_code
  ` as DbRow[];

  const lines: CaseWareLine[] = [];
  for (const r of rows) {
    const net = round2(Number(r.debit || 0) - Number(r.credit || 0));
    if (net === 0) continue;
    lines.push({
      accountCode: String(r.AccountCode ?? ''),
      accountName: String(r.AccountName ?? ''),
      net,
      casewareCode: String(r.CaseWareCode ?? ''),
      casewareLabel: String(r.CaseWareLabel ?? ''),
    });
  }

  await addBroughtForward(lines, companyId, periodStart);

  const header = ['AccountCode', 'AccountName', 'Debit', 'Credit', 'NetBalance', 'CaseWareCode', 'CaseWareLabel'];
  const csvLines = [header.join(',')];
  for (const line of lines) {
    const { debit, credit } = splitNet(line.net);
    csvLines.push([
      escapeCsv(line.accountCode),
      escapeCsv(line.accountName),
      debit.toFixed(2),
      credit.toFixed(2),
      line.net.toFixed(2),
      escapeCsv(line.casewareCode),
      escapeCsv(line.casewareLabel),
    ].join(','));
  }

  return csvLines.join('\r\n');
}

/**
 * Append profit earned before `periodStart` as a derived retained-earnings line.
 *
 * Without it the export omits prior years' results entirely and no longer
 * balances, because the ledger holds no year-end closing journals. It gets its
 * own row rather than being added to the company's posted retained-earnings
 * account: an auditor importing this into CaseWare must be able to see which
 * figure came from the ledger and which one was computed. The CaseWare code is
 * still the retained-earnings mapping, so it classifies correctly on import.
 */
async function addBroughtForward(
  lines: CaseWareLine[],
  companyId: string,
  periodStart: string,
): Promise<void> {
  const broughtForward = await getRetainedEarningsBroughtForward(companyId, periodStart);
  if (Math.abs(broughtForward) < 0.01) return;
  const { accountCode, accountName } = broughtForwardLine(periodStart);
  const suggestion = CASEWARE_SUGGESTIONS['equity:retained'] ?? { code: 'D20', label: 'Retained earnings' };
  lines.push({
    accountCode,
    accountName,
    net: round2(-broughtForward),
    casewareCode: suggestion.code,
    casewareLabel: suggestion.label,
  });
  lines.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

// ── Auto-suggest all codes for company ────────────────────────────────────────

export async function autoSuggestAllMappings(
  companyId: string,
): Promise<Array<{ glAccountId: string; code: string; label: string }>> {
  const rows = await sql`
    SELECT id, account_type, account_subtype
    FROM gl_accounts
    WHERE company_id = ${companyId} AND is_active = true
  ` as DbRow[];

  return rows.map((r: DbRow) => {
    const suggestion = CASEWARE_SUGGESTIONS[`${r.account_type}:${r.account_subtype ?? ''}`]
      ?? CASEWARE_SUGGESTIONS[`${r.account_type}:`]
      ?? { code: 'Z99', label: 'Unclassified' };
    return { glAccountId: String(r.id), code: suggestion.code, label: suggestion.label };
  });
}
