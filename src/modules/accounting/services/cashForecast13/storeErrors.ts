/**
 * Typed refusals of the 13-week cash forecast's write services. The routes map them with
 * respondCashForecastStoreError: input 400, not found 404. A duplicate override is never an error:
 * overrides upsert on (company, line, week).
 */
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';

/** A value the request validated but the company's data refuses (e.g. an account of another company). 400. */
export class CashForecastInputError extends Error {
  constructor(message: string) { super(message); this.name = 'CashForecastInputError'; }
}

/** No row of this company has that id. 404. */
export class CashForecastNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'CashForecastNotFoundError'; }
}

/** Answers a typed refusal; returns true when it did. */
export function respondCashForecastStoreError(res: NextApiResponse, err: unknown): boolean {
  if (err instanceof CashForecastInputError) { apiResponse.badRequest(res, err.message); return true; }
  if (err instanceof CashForecastNotFoundError) { apiResponse.error(res, ErrorCode.NOT_FOUND, err.message); return true; }
  return false;
}
