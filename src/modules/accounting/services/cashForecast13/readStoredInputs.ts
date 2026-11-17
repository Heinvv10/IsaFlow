/**
 * The user's stored inputs for the forecast (migration 999i: manual items, week overrides, the salary pay day),
 * read through their repos and converted by engineAdapter. Each read is its own guarded source, so a store the
 * database cannot read becomes a `source_unavailable` warning (no items / no overrides / the default pay day)
 * and the forecast goes on.
 */
import { guardedSource } from './guardedSource';
import { listItems } from './itemsRepo';
import { listOverrides } from './overridesRepo';
import { getPayDay } from './payDaySetting';
import { horizonStart, toEngineManualItems, toEngineOverrides, toEnginePayDay } from './engineAdapter';
import type { PayDay } from './payDates';
import type { ForecastWarning, ManualItem, Override } from './types';

export interface StoredInputs { payDay: PayDay | null; manualItems: ManualItem[]; overrides: Override[] }

export async function readStoredInputs(companyId: string, today: string, warnings: ForecastWarning[]): Promise<StoredInputs> {
  const items = await guardedSource('cash13_manual', 'expected cash items', warnings, () => listItems(companyId));
  const overrides = await guardedSource('cash13_overrides', 'forecast overrides', warnings, () => listOverrides(companyId, horizonStart(today)));
  const payDay = await guardedSource('cash13_pay_day', 'salary pay day', warnings, () => getPayDay(companyId));
  return {
    payDay: payDay ? toEnginePayDay(payDay.payDay) : null,
    manualItems: items ? toEngineManualItems(items) : [],
    overrides: overrides ? toEngineOverrides(overrides, today) : [],
  };
}
