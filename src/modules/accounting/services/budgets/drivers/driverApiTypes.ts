/**
 * The wire types of `pages/api/accounting/budget-drivers/**`, derived from the services the
 * handlers pass through (registered in `src/lib/apiRoutes.ts`; never hand-written shapes). A
 * route answering several methods is the union of what each answers.
 */
import type { deleteDriver, listDrivers, refreshHeadcount, resetOverride, saveDriver } from './driverWriteService';
import type { createHire, deleteHire, listHires, readHeadcount, updateHire } from './plannedHireService';

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

/** GET the list, PUT the saved driver, DELETE `{ deleted, id }`; writes add the token and the recompute count. */
export type DriversResponse = Answer<typeof listDrivers> | Answer<typeof saveDriver> | Answer<typeof deleteDriver>;
export type DriverOverrideResponse = Answer<typeof resetOverride>;
/** GET the counts; POST "Refresh headcount". */
export type DriverHeadcountResponse = Answer<typeof readHeadcount> | Answer<typeof refreshHeadcount>;
export type PlannedHiresResponse = Answer<typeof listHires> | Answer<typeof createHire> | Answer<typeof updateHire> | Answer<typeof deleteHire>;
