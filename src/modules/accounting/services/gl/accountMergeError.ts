/**
 * The merge's refusal class. Moved out of accountMergeGuards unchanged, so that
 * a guard living in its own file (accountMergeRoleGuard) can throw it without
 * importing accountMergeGuards, which imports that guard.
 */
import type { MergeRefusalCode } from './accountMergeGuards';
import type { ConfigurationReference } from './accountMergeReferences';

/** Every refusal, so a caller can map the whole class to one toolError / 400. */
export class AccountMergeError extends Error {
  constructor(
    message: string,
    readonly code: MergeRefusalCode,
    readonly references: ConfigurationReference[] = [],
  ) {
    super(message);
    this.name = 'AccountMergeError';
  }
}
