import type {CloseYearError} from '../gl/yearEndCloseService';
/** Carries actionable close diagnostics while approval materialization still fails closed. */
export class YearEndEligibilityError extends Error {
 constructor(readonly result:CloseYearError){super(`Financial year is ineligible: ${result.error}`);this.name='YearEndEligibilityError';}
}
