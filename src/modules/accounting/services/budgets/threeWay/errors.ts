/**
 * Typed refusals of the three-way engine and its assumptions resolver. A DB
 * service (PR C) maps them to responses by class and `code`; none carries
 * company data beyond ids and cent figures.
 */

/** Opening |assets − liabilities − equity| > 1 cent: no plug, no suspense (spec §5). */
export class OpeningUnbalancedError extends Error {
  readonly code = 'OPENING_UNBALANCED' as const;
  constructor(readonly differenceCents: number) {
    super(`Opening balance sheet does not balance: assets − liabilities − equity = ${differenceCents} cents`);
    this.name = 'OpeningUnbalancedError';
  }
}

export type EngineInputErrorCode =
  | 'MONTHS' | 'PNL' | 'LOOKBACK' | 'OPENING' | 'LOAN_SCHEDULE' | 'CHECKS' | 'AMOUNT';

/** The engine input is malformed (a caller bug, not a user error). */
export class EngineInputError extends Error {
  constructor(readonly code: EngineInputErrorCode, message: string) {
    super(message);
    this.name = 'EngineInputError';
  }
}

/** A posting whose debits and credits differ (spec §5: every posting asserts Σdr = Σcr). */
export class UnbalancedPostingError extends Error {
  readonly code = 'UNBALANCED_POSTING' as const;
  constructor(readonly step: string, readonly month: string, readonly sumCents: number) {
    super(`Posting ${step} in ${month} is unbalanced by ${sumCents} cents`);
    this.name = 'UnbalancedPostingError';
  }
}

export type AssumptionChainErrorCode =
  | 'VERSION_NOT_FOUND' | 'BASE_MISSING' | 'CROSS_COMPANY' | 'CROSS_YEAR'
  | 'CYCLE' | 'TOO_DEEP' | 'OVERRIDES_ON_NON_SCENARIO';

/** A scenario chain that cannot be resolved (spec §13.21). `path` = version ids walked, target first. */
export class AssumptionChainError extends Error {
  constructor(readonly code: AssumptionChainErrorCode, message: string, readonly path: readonly string[]) {
    super(message);
    this.name = 'AssumptionChainError';
  }
}

export interface AssumptionsIssue { path: string; message: string }

/** A stored or merged assumptions document that fails the schema. */
export class AssumptionsDocError extends Error {
  readonly code = 'ASSUMPTIONS_INVALID' as const;
  constructor(readonly issues: readonly AssumptionsIssue[]) {
    super(`Assumptions document is invalid: ${issues.map(i => `${i.path || '(root)'} ${i.message}`).join('; ')}`);
    this.name = 'AssumptionsDocError';
  }
}

export type CompareInputErrorCode = 'COUNT' | 'MONTHS';

/** compare() needs 1–3 outputs over the same months. */
export class CompareInputError extends Error {
  constructor(readonly code: CompareInputErrorCode, message: string) {
    super(message);
    this.name = 'CompareInputError';
  }
}
