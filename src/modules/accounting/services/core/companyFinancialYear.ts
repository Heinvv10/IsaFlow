/**
 * companyService.updateCompany's half of a financial year start change: the
 * period rebuild after its UPDATE (the check before it is
 * gl/fiscalYearStartChange.assertFinancialYearStartChange).
 */

import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { rebuildUnusedFiscalPeriods } from '@/modules/accounting/services/gl/fiscalYearStartChange';

/**
 * The rebuild after the UPDATE. Its own refusal (FiscalPeriodsInUseError, a 409)
 * is unreachable under the row lock assertFinancialYearStartChange holds, but a
 * 4xx commits: the row would keep the new month over the old periods. So any
 * failure here is a 500 and the request is marked rollback-only.
 */
export async function rebuildOrRollBack(id: string): Promise<void> {
  try {
    await rebuildUnusedFiscalPeriods(id);
  } catch (err) {
    const store = als.getStore();
    if (store) store.rollbackOnly = 'fiscal period rebuild failed after the financial_year_start UPDATE';
    log.error('Fiscal period rebuild failed after the company UPDATE', { companyId: id, error: String(err) }, 'accounting');
    throw new Error(`Fiscal period rebuild failed after the financial year start change: ${String(err)}`);
  }
}
