/**
 * Consent / PAT-mint scope gating — ZERO runtime imports (client-bundle safe).
 *
 * The Hein decision (2026-07-18, settled): posting scopes are opt-in. Even
 * when a client requests `write:post` in its authorize URL, the consent
 * screen must present it UNCHECKED and grant it only when the user actively
 * ticks it. Read + draft-write scopes are auto-granted as before.
 */

/** Scopes that require an explicit, unchecked-by-default user opt-in. */
export const OPT_IN_SCOPES = ['write:post', 'write:assets', 'write:approvals', 'write:beneficiaries', 'write:audit', 'write:controls', 'write:locks', 'read:payroll-sensitive'] as const;
export type OptInScope = (typeof OPT_IN_SCOPES)[number];

export function isOptInScope(scope: string): boolean {
  return (OPT_IN_SCOPES as readonly string[]).includes(scope);
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
