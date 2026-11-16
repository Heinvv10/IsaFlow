/**
 * Fixed facts of the Demo company reseed. Nothing here is configurable by
 * environment: the tool reseeds the Demo company and no other.
 */

export const DEMO_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
export const DEMO_COMPANY_NAME = 'IsaFlow Demo (Pty) Ltd';
export const DEMO_TRADING_NAME = 'IsaFlow Demo';

/** The window is 24 calendar months: 23 full months back plus the current, partial one. */
export const DEMO_MONTHS_BACK = 23;
/** Nothing is ever seeded after the run date. */
export const DEMO_MONTHS_FORWARD = 0;

export const DEFAULT_SEED = 20261116;

/** The only env var the tool reads its database URL from (no fallback, no .env file). */
export const DB_URL_ENV = 'DEMO_RESEED_DATABASE_URL';

/** Used as created_by / approved_by when the company has no owner membership to name. */
export const FALLBACK_ACTOR_ID = 'a0000000-0000-0000-0000-000000000001';

/**
 * The golden payroll sandbox month, as the deploy gate's suite pins it (PAYROLL_SANDBOX_MONTH in
 * tests/e2e/golden-paths/_api.ts). Post-checks G1/G2 read it from here; a change there must change this.
 */
export const GOLDEN_PAYROLL_SANDBOX = { year: 2027, month: 2 } as const;
