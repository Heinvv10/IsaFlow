/** The typed refusals of the SARS eFiling submission service, moved out of it (a pure move; the service re-exports them). */
import { ISV_PAYLOAD_UNMAPPED_REASON } from './sarsEfilingPayloadGuard';

export class EfilingNotConfiguredError extends Error {
  constructor() {
    super('SARS eFiling is not configured on this server');
    this.name = 'EfilingNotConfiguredError';
  }
}
export class EfilingSubmissionNotFoundError extends Error {
  constructor(id: string) {
    super(`SARS submission ${id} not found`);
    this.name = 'EfilingSubmissionNotFoundError';
  }
}
/** A deliberate refusal to file — exceptions present, degraded data, bad VAT
 *  number, or nothing to poll. NOT a system error; surfaced to the user as
 *  "do not file". */
export class EfilingBlockedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'EfilingBlockedError';
    this.reason = reason;
  }
}
/** The submit path is refused until its payload is in SARS's field numbers (sarsEfilingPayloadGuard). */
export class EfilingPayloadUnmappedError extends EfilingBlockedError {
  constructor() {
    super(ISV_PAYLOAD_UNMAPPED_REASON);
    this.name = 'EfilingPayloadUnmappedError';
  }
}
/** A previous send of this return may have reached SARS (its intent has no result, or its result was lost): poll or reconcile first. */
export class EfilingSendUncertainError extends Error {
  constructor(readonly correlationId: string | null) {
    super('A previous send of this VAT201 may have reached SARS: poll or reconcile it before sending again');
    this.name = 'EfilingSendUncertainError';
  }
}
/** The VAT201 was already filed to SARS — refuse to file it twice (a double
 *  statutory submission). Carries the existing correlation id for reference. */
export class EfilingAlreadyFiledError extends Error {
  readonly correlationId: string;
  constructor(correlationId: string) {
    super('This VAT201 has already been filed to SARS');
    this.name = 'EfilingAlreadyFiledError';
    this.correlationId = correlationId;
  }
}
