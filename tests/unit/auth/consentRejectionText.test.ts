/**
 * The rejection screen may not repeat attacker-supplied text back at the user.
 *
 * `/oauth/authorize?...&scope=<anything>` renders ConsentRejected inside an
 * ISAFlow-branded panel headed "Authorisation request rejected". The scope
 * token was interpolated verbatim (`Unknown scope: ${s}`), so a crafted link
 * put attacker-chosen words in the one place a reader trusts as ours.
 *
 * React escapes it, so this was never XSS — it is content injection, and the
 * fix is a constant plus a log line, not an escape (#480).
 *
 * Precondition for the attack is a logged-in victim, since getServerSideProps
 * redirects to /login first. That is the same precondition as the consent
 * screen itself, so it narrows nothing.
 */
import { describe, it, expect } from 'vitest';
import { rejectionForUnknownScope, UNKNOWN_SCOPE_MESSAGE } from '@/lib/auth/consentRejection';

describe('rejectionForUnknownScope', () => {
  it('returns a constant, whatever the scope token says', () => {
    const crafted = 'read:invoices - ISAFlow support needs your password';
    expect(rejectionForUnknownScope(crafted)).toBe(UNKNOWN_SCOPE_MESSAGE);
    expect(rejectionForUnknownScope(crafted)).not.toContain('password');
  });

  it('gives the same string for every rejected token', () => {
    // No branch on content: two different tokens are indistinguishable to the
    // page, so nothing an attacker chooses can change a single character.
    expect(rejectionForUnknownScope('aaa')).toBe(rejectionForUnknownScope('bbb'));
  });

  it('explains the refusal in plain words and states nothing was shared', () => {
    // Deliberately not the word "scope": the reader is the account holder, not
    // the developer who mistyped it. The developer's signal is the log line at
    // the call site, which does carry the offending token.
    expect(UNKNOWN_SCOPE_MESSAGE).toMatch(/permission/i);
    expect(UNKNOWN_SCOPE_MESSAGE).toMatch(/nothing was shared/i);
  });
});
