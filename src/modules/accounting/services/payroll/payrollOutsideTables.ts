/**
 * The stored-line test for "this month's PAYE did not come from the tables" (PAYE_OUTSIDE_TABLES, taxStatusTreatment), as the
 * jsonb the year-to-date queries match a line's validation_results against (the @> containment the other line codes use).
 */
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';

export const outsideTablesFlag: string = JSON.stringify([{ code: PAYE_OUTSIDE_TABLES }]);

/** The same test for an independent contractor's line (treatment none): not remuneration for SDL's s4(b) threshold, nor on the UI-19. */
export const contractorLineFlag: string = JSON.stringify([{ code: PAYE_OUTSIDE_TABLES, treatment: 'none' }]);

/** Whether a calculated line is a contractor's (its PAYE_OUTSIDE_TABLES result says treatment none). */
export function isContractorLine(results: ReadonlyArray<{ code: string; treatment?: string }>): boolean {
  return results.some(v => v.code === PAYE_OUTSIDE_TABLES && v.treatment === 'none');
}
