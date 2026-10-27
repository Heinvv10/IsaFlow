// src/lib/auth/maskInviteEmail.ts — no Node imports: the invite page uses it in the browser too.

/**
 * How an invited address is shown to whoever holds the link: first letter and
 * domain (`h***@velocityfibre.co.za`). One definition, because the invite page
 * compares the signed-in address against the masked one the API returned, and
 * two copies that drifted (case, say) would make that comparison lie.
 */
export function maskInviteEmail(email: string): string {
  const [local, domain] = email.toLowerCase().split('@');
  if (!local || !domain) return '***@***';
  return `${local[0]}***@${domain}`;
}
