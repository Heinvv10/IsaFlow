// A pre-export finding for accounts mapped to the wrong statement.
//
// The balance-sheet lines sum an account's posted balance from inception, and the Statement of Financial
// Position then adds the profit to date as accumulated profit (derivedAccumulatedProfit). A revenue or expense
// account mapped to a BALANCE-SHEET line is therefore counted twice: once as itself, once inside the derived
// profit. (While the year-end close was read as a posted journal it zeroed those accounts and hid this.) The
// balance check blocks the export, but says only "out by R x"; this names the accounts, so the user knows why.
// The reverse, an asset/liability/equity account on an INCOME line, puts a stock on a flow statement, except a
// dividends account on IS484 "Dividends paid" (debit-normal, or subtype 'dividends'): the balance sheet and the
// changes in equity carry it (dividendsPaid.ts). Share capital or a reserve there is still named.
//
// It reports. It does not change a mapping.

import { sql } from '@/lib/neon';
import type { ExportCheck } from './afsPreExportChecks';
import { DIVIDENDS_PAID_CODE } from './noteGenerators/primaryStatements/dividendsPaid';

interface Misplaced { account_code: string; account_name: string; account_type: string; afs_line_code: string; section: string }

const SHOWN = 10;

const REMAP = 'Remap each to a line of its own statement.';
// Revenue or expense on a balance-sheet line: the balance sheet also adds the profit to date, which holds the same figure.
const TWICE_ADVICE = 'A revenue or expense account on a balance sheet line is counted twice (again inside the '
  + `accumulated profit), which is why the balance sheet may not balance. ${REMAP}`;
// An asset, liability or equity account on an income-statement line: a balance reported as a movement.
const STOCK_ADVICE = 'An asset, liability or equity account on an income statement line is a balance shown as a '
  + `period movement and missing from the balance sheet, which is why the balance sheet may not balance. ${REMAP}`;

async function checkAccountsMappedToTheirStatement(companyId: string): Promise<ExportCheck | null> {
  const rows = (await sql`
    SELECT ga.account_code, ga.account_name, ga.account_type, m.afs_line_code, sl.section
    FROM afs_account_mappings m
    JOIN afs_statement_lines sl ON sl.code = m.afs_line_code AND sl.company_id = m.company_id
    JOIN gl_accounts ga ON ga.id = m.gl_account_id AND ga.company_id = m.company_id
    WHERE m.company_id = ${companyId}::UUID
      AND sl.is_active = true
      AND ((sl.section = 'balance_sheet' AND ga.account_type IN ('revenue', 'expense'))
        OR (sl.section = 'income_statement' AND ga.account_type IN ('asset', 'liability', 'equity')
          AND NOT (ga.account_type = 'equity' AND (ga.normal_balance = 'debit' OR ga.account_subtype = 'dividends') AND m.afs_line_code = ${DIVIDENDS_PAID_CODE})))
    ORDER BY ga.account_code, m.afs_line_code
  `) as Misplaced[] | undefined;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const named = rows.slice(0, SHOWN).map((r) =>
    `${r.account_code} ${r.account_name} (${r.account_type}) is mapped to ${r.afs_line_code}, `
    + `${r.section === 'balance_sheet' ? 'a balance sheet' : 'an income statement'} line`);
  const more = rows.length > SHOWN ? `; and ${rows.length - SHOWN} more` : '';
  const advice = [
    rows.some((r) => r.section === 'balance_sheet') ? TWICE_ADVICE : null,
    rows.some((r) => r.section === 'income_statement') ? STOCK_ADVICE : null,
  ].filter((a): a is string => a !== null);
  return {
    label: 'Every mapped account is on the right statement',
    passed: false,
    severity: 'warning',
    detail: `${named.join('; ')}${more}. ${advice.join(' ')}`,
  };
}

/** The AFS checks, plus the misplaced-account finding only when there is one (a clean company's list is unchanged). */
export async function withStatementMappingFinding(
  checks: ExportCheck[], companyId: string, isAfs: boolean,
): Promise<ExportCheck[]> {
  const misplaced = isAfs ? await checkAccountsMappedToTheirStatement(companyId) : null;
  return misplaced ? [...checks, misplaced] : checks;
}
