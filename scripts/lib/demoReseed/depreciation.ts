/**
 * The fixed assets' depreciation history, posted by the app's own depreciation
 * service (the one behind pages/api/accounting/run-depreciation.ts) for every
 * completed month from the first purchase to last month end, on the reseed's
 * transaction. The current month is left for the user (and the golden spec)
 * to run. A month whose fiscal period is closed is refused by the service and
 * skipped (counted), never forced.
 */

import type pg from 'pg';
import {
  DepreciationRunBlockedError,
  runDepreciation,
} from '../../../src/modules/accounting/services/items/depreciationRunService';
import { withAppContext } from './appContext';
import { addMonths, monthEnd, ym, type Window } from './dates';

export interface DepreciationHistory { months: number; journals: number; skippedClosed: string[]; glFailed: number }

export async function postDepreciationHistory(
  client: pg.Client,
  companyId: string,
  actorId: string,
  firstPurchase: string,
  win: Window,
): Promise<DepreciationHistory> {
  const out: DepreciationHistory = { months: 0, journals: 0, skippedClosed: [], glFailed: 0 };
  let { year, month } = ym(firstPurchase);
  while (monthEnd(year, month) <= win.lastMonthEnd) {
    const periodDate = monthEnd(year, month);
    try {
      const r = await withAppContext(client, { userId: actorId, companyId }, () => runDepreciation(companyId, actorId, periodDate));
      out.months += 1;
      out.journals += r.processed;
      out.glFailed += r.glFailed;
    } catch (err) {
      if (!(err instanceof DepreciationRunBlockedError)) throw err;
      out.skippedClosed.push(periodDate);
    }
    ({ year, month } = addMonths(year, month, 1));
  }
  if (out.glFailed > 0) throw new Error(`depreciation history: ${out.glFailed} asset-month(s) failed to post`);
  return out;
}
