/** Moved out of writeEmployees.ts unchanged, so the employee tool files share it. */
/**
 * `YYYY-MM-DD` from the agent, as a Date the services take.
 *
 * LOCAL midnight, not UTC. The services render these back through `fmtDate`,
 * which uses local calendar getters on purpose — `toISOString()` there reported
 * the PREVIOUS day on the UTC+2 host and shifted journal dates across VAT
 * period boundaries (see `src/lib/pgTypes.ts`). A Date built at UTC midnight
 * survives that on a UTC or UTC-plus host and silently loses a day on a
 * UTC-minus one, so it is built where it is read instead.
 */
export function asDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
