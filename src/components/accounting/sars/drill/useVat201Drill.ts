/** One page of one VAT201 field's drill (see useDrillPages). */
import type { Vat201DrillResult } from '@/modules/accounting/services/reports/vat201FieldDrill';
import { fetchVat201Drill } from './returnDrillClient';
import { useDrillPages } from './useDrillPages';

export type { DrillFailure } from './useDrillPages';

export function useVat201Drill(field: string | null, from: string, to: string) {
  return useDrillPages<Vat201DrillResult>(field !== null, `${field}|${from}|${to}`,
    (page, signal) => fetchVat201Drill(field as string, from, to, page, signal));
}
