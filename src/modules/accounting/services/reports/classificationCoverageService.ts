/**
 * How much of a P&L rests on a classification nobody made.
 *
 * Every band in an income statement — cost of sales, other income, finance
 * cost, tax — is chosen from `account_subtype`. That is right: choosing them by
 * account NAME is what the audit caught. But a figure driven by subtype is
 * exactly as good as the subtypes, and on these books they barely exist.
 *
 *   Velocity Fibre   100% of revenue (R84,053,370.26) and 97.6% of expenses
 *                    (R115,984,525.05 of R118,869,595.15) sit on accounts whose
 *                    subtype is NULL or a `default_*` placeholder.
 *   Brightsphere     91.9% of revenue (R12,410,997.90 of R13,508,486.83).
 *
 * Velocity's classified cost of sales is R2,885,070.10, so its reported gross
 * profit of R29,305,100.49 is revenue less 2.4% of its costs. That figure is
 * not wrong in the sense of a bug — the code did exactly what the chart of
 * accounts told it — and it is not a number any human should act on. Printing
 * it without that sentence beside it is the ten-row aged debtors again: a
 * plausible figure whose completeness cannot be established from the response.
 *
 * So `profit_and_loss` reports this at EVERY detail level and it cannot be
 * suppressed. NOTHING IS EXCLUDED FROM ANY TOTAL — an unclassified expense is
 * still an expense, and the classification is the finding, not a filter.
 *
 * `default_expense` and `default_revenue` count as UNCLASSIFIED. They are
 * placeholders the importers write, not decisions anyone made; treating them as
 * classified would report Velocity as better classified than it is.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { canonicalSubtype } from '@/modules/accounting/services/gl/accountClassification';

/**
 * How many unclassified accounts are named per side. The COUNT and the AMOUNT
 * are always complete; only this list is capped, and `truncated` says when it
 * was. A chart with hundreds of unclassified accounts has a bigger problem than
 * a shortened list.
 */
const ACCOUNT_CAP = 50;

export interface UnclassifiedAccount {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The raw subtype as stored — null, or the placeholder that was written. */
  accountSubtype: string | null;
  /** Movement over the period, signed in the account's normal direction. */
  amount: number;
}

export interface CoverageSide {
  /** Movement over every account of this type. Nothing is filtered out. */
  totalAmount: number;
  classifiedAmount: number;
  unclassifiedAmount: number;
  /** Complete count, not the length of `accounts`. */
  unclassifiedAccountCount: number;
  /** Capped sample, largest first — the ones worth classifying. */
  accounts: UnclassifiedAccount[];
  truncated: boolean;
}

export interface ClassificationCoverage {
  revenue: CoverageSide;
  expense: CoverageSide;
}

/** A subtype that expresses no decision: absent, or an importer placeholder. */
function isUnclassified(subtype: string | null): boolean {
  if (subtype === null || subtype.trim() === '') return true;
  if (subtype === 'default_expense' || subtype === 'default_revenue') return true;
  // Anything the shared canonicaliser cannot place is a subtype nobody's report
  // can act on, so it is unclassified for this purpose too.
  return canonicalSubtype(subtype) === null;
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

function emptySide(): CoverageSide {
  return {
    totalAmount: 0, classifiedAmount: 0, unclassifiedAmount: 0,
    unclassifiedAccountCount: 0, accounts: [], truncated: false,
  };
}

/**
 * @param periodStart 'YYYY-MM-DD'. Strings throughout — no Date arithmetic.
 */
export async function getClassificationCoverage(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  costCentreId?: string,
): Promise<ClassificationCoverage> {
  const ccId = costCentreId ?? null;
  try {
    const rows = (await sql`
      SELECT ga.id AS account_id, ga.account_code, ga.account_name,
             ga.account_type, ga.account_subtype,
             COALESCE(SUM(jl.debit), 0)  AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.entry_date >= ${periodStart}::DATE
        AND je.entry_date <= ${periodEnd}::DATE
        AND ga.account_type IN ('revenue', 'expense')
        AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype
      ORDER BY ga.account_code
    `) as DbRow[];

    const out: ClassificationCoverage = { revenue: emptySide(), expense: emptySide() };
    const unclassified: Record<'revenue' | 'expense', UnclassifiedAccount[]> = {
      revenue: [], expense: [],
    };

    for (const r of rows) {
      const type = String(r.account_type) === 'revenue' ? 'revenue' : 'expense';
      const debit = Number(r.total_debit ?? 0);
      const credit = Number(r.total_credit ?? 0);
      // Signed in the account's normal direction, so the totals tie to the
      // income statement's own revenue and expense figures.
      const amount = type === 'revenue' ? credit - debit : debit - credit;
      const subtype = r.account_subtype == null ? null : String(r.account_subtype);

      const side = out[type];
      side.totalAmount += amount;
      if (isUnclassified(subtype)) {
        side.unclassifiedAmount += amount;
        side.unclassifiedAccountCount += 1;
        unclassified[type].push({
          accountId: String(r.account_id),
          accountCode: String(r.account_code ?? ''),
          accountName: String(r.account_name ?? ''),
          accountSubtype: subtype,
          amount: round2(amount),
        });
      } else {
        side.classifiedAmount += amount;
      }
    }

    for (const type of ['revenue', 'expense'] as const) {
      const side = out[type];
      side.totalAmount = round2(side.totalAmount);
      side.classifiedAmount = round2(side.classifiedAmount);
      side.unclassifiedAmount = round2(side.unclassifiedAmount);
      // Largest first: those are the accounts worth classifying, and a capped
      // list ordered by account code would name the alphabetically unlucky.
      const sorted = unclassified[type].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      side.accounts = sorted.slice(0, ACCOUNT_CAP);
      side.truncated = sorted.length > ACCOUNT_CAP;
    }

    return out;
  } catch (err) {
    log.error('Failed to read P&L classification coverage', { error: err }, 'accounting');
    throw err;
  }
}
