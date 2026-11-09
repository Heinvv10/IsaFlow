/**
 * The stored-line test for "this month's PAYE did not come from the tables" (PAYE_OUTSIDE_TABLES, taxStatusTreatment), as the
 * jsonb the year-to-date queries match a line's validation_results against (the @> containment the other line codes use).
 */
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';

export const outsideTablesFlag: string = JSON.stringify([{ code: PAYE_OUTSIDE_TABLES }]);
