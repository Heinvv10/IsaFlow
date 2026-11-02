/**
 * Consent scope gating. Its only runtime dependency is the client-safe OAuth
 * vocabulary, so this module remains safe to import from the consent page.
 *
 * Every write scope is opt-in. Even when a client requests one in its
 * authorize URL, the consent screen presents it unchecked and grants it only
 * when the user ticks it. Read scopes and offline_access stay automatic.
 */
import { OAUTH_SCOPES, type OAuthScope } from './oauthScopes';

/** Every write scope in the canonical OAuth vocabulary, including future ones. */
export type OptInScope = Extract<OAuthScope, `write:${string}`>;
export const OPT_IN_SCOPES: readonly OptInScope[] = OAUTH_SCOPES.filter(
  (scope): scope is OptInScope => scope.startsWith('write:'),
);

export function isOptInScope(scope: string): boolean {
  return OPT_IN_SCOPES.includes(scope as OptInScope);
}

/** Split the client's requested scopes into auto-granted and opt-in sets,
 *  preserving request order within each. */
export function partitionRequestedScopes(requested: string[]): {
  autoGranted: string[];
  optIn: string[];
} {
  const autoGranted: string[] = [];
  const optIn: string[] = [];
  for (const s of requested) {
    (isOptInScope(s) ? optIn : autoGranted).push(s);
  }
  return { autoGranted, optIn };
}

/** Final granted set: every auto-granted scope, plus any opt-in scope that
 *  was BOTH requested (present in `optIn`) AND explicitly ticked. A checked
 *  flag for a scope the client never requested is ignored. */
export function buildGrantedScopes(
  autoGranted: string[],
  optIn: string[],
  checked: Record<string, boolean>,
): string[] {
  const granted = [...autoGranted];
  for (const s of optIn) {
    if (checked[s]) granted.push(s);
  }
  return granted;
}
