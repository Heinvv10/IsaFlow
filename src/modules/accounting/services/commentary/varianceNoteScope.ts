/**
 * What a variance note may be filed against (budgets P5 spec §3e, §4): a budget version of the company,
 * a month of that version's financial year, a revenue or expense account of the company, and dimension
 * ids of the company of the right level. Every id is looked up under `company_id`, so another tenant's id
 * answers `not_found` exactly as a missing one does. Sequential reads (one pg client under withAuth).
 */
import { sql, type DbRow } from '@/lib/neon';
import { isValidUUID } from '@/lib/validation';
import { versionYear } from '@/modules/accounting/services/budgets/budgetVersionScope';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { budgetMonthBounds } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { resolveTrackingFilter } from '@/modules/accounting/services/budgets/tracking/trackingFilter';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { VARIANCE_MONTH_RE, type VarianceSlice } from './varianceNoteTypes';

export type ScopeFailure = { ok: false; code: 'not_found' | 'bad_request'; reason: string };

const notFound = (what: string): ScopeFailure => ({ ok: false, code: 'not_found', reason: `${what} not found.` });
const bad = (reason: string): ScopeFailure => ({ ok: false, code: 'bad_request', reason });

/** The version is the company's and the month ('YYYY-MM') lies in its financial year. */
export async function checkVersionMonth(companyId: string, versionId: string, month: string): Promise<ScopeFailure | null> {
  if (!isValidUUID(versionId)) return notFound('Budget version');
  if (!VARIANCE_MONTH_RE.test(month)) return bad('month must be YYYY-MM.');
  let start: string;
  let end: string;
  try {
    const year = await versionYear(companyId, versionId);
    start = year.startDate;
    end = year.endDate;
  } catch (err) {
    if (err instanceof BudgetVersionError) {
      return err.code === 'BUDGET_VERSION_NOT_FOUND' ? notFound('Budget version') : bad(err.message);
    }
    throw err;
  }
  const own = budgetMonthBounds(start, end);
  const first = `${month}-01`;
  if (!own || first < own.first || first > own.last) {
    return bad(`${month} is not a month of this budget version's financial year.`);
  }
  return null;
}

/** The account is the company's income-statement account, and each dimension the company's, of its level. */
export async function checkSlice(companyId: string, s: VarianceSlice): Promise<ScopeFailure | null> {
  if (!isValidUUID(s.glAccountId)) return notFound('Account');
  const rows = (await sql`
    SELECT account_type FROM gl_accounts WHERE id = ${s.glAccountId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!rows[0]) return notFound('Account');
  if (!['revenue', 'expense'].includes(String(rows[0].account_type))) {
    return bad('A variance note belongs to a revenue or expense account.');
  }
  try {
    // The Budget vs Actual filter's own lookup: company-scoped ids (404), cc1 a CC1, cc2 a CC2 (400).
    await resolveTrackingFilter(companyId, {
      ...(s.cc1Id !== null ? { cc1Id: s.cc1Id } : {}),
      ...(s.cc2Id !== null ? { cc2Id: s.cc2Id } : {}),
      ...(s.buId !== null ? { buId: s.buId } : {}),
    });
  } catch (err) {
    if (err instanceof TrackingError) return err.status === 404 ? notFound('Cost centre or business unit') : bad(err.message);
    throw err;
  }
  return null;
}
