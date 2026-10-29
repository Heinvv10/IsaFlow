/**
 * A driver refusal the routes answer 400 with `error.details.code` (P4 spec §5): DRIVER_CYCLE
 * (with `path`, the row keys around it, first == last), DRIVER_REF (a row, month, base or field
 * the driver may not name) or DRIVER_RANGE (an amount, percentage or result beyond the budget range).
 */
import { DriverCycleError, DriverRangeError, DriverRefError, type RowKey } from './driverTypes';

export type BudgetDriverErrorCode = 'DRIVER_CYCLE' | 'DRIVER_REF' | 'DRIVER_RANGE';

export class BudgetDriverError extends Error {
  readonly status = 400;
  constructor(readonly code: BudgetDriverErrorCode, message: string, readonly path: RowKey[] | null = null) {
    super(message);
    this.name = 'BudgetDriverError';
  }
}

/** The engine's refusals and BudgetDriverError as one shape; null for anything else. */
export function driverRefusal(err: unknown): BudgetDriverError | null {
  if (err instanceof BudgetDriverError) return err;
  if (err instanceof DriverCycleError) return new BudgetDriverError('DRIVER_CYCLE', err.message, err.path);
  if (err instanceof DriverRefError) return new BudgetDriverError('DRIVER_REF', err.message);
  if (err instanceof DriverRangeError) return new BudgetDriverError('DRIVER_RANGE', err.message);
  return null;
}
