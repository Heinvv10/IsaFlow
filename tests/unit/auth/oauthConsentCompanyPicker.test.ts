/**
 * Consent screen — which company the grant gets pinned to.
 *
 * The grant is pinned to ONE company for the life of the token: bearerPipeline
 * pushes it into the RLS GUC per request and never re-reads a cookie. So the
 * consent screen has to state which company it is about to hand over, and let
 * a multi-company user choose — otherwise the only signal is whichever company
 * happened to be active in the browser, which is how a grant silently lands on
 * the wrong tenant (observed in prod 2026-08-09: a Velocity Fibre connector
 * resolving to Brightsphere).
 *
 * Invariants:
 *  - options come from real memberships, never from client input
 *  - the default is the active company when it IS a membership
 *  - an active-company value outside the memberships is ignored, not trusted
 *  - no memberships → no grantable consent screen
 */
import { describe, it, expect } from 'vitest';
import { resolveConsentCompany } from '@/lib/auth/consentCompany';

const BRIGHTSPHERE = '11111111-1111-1111-1111-111111111111';
const VELOCITY = '22222222-2222-2222-2222-222222222222';
const H10 = '33333333-3333-3333-3333-333333333333';
const OUTSIDER = '99999999-9999-9999-9999-999999999999';

const MEMBERSHIPS = [
  { companyId: BRIGHTSPHERE, companyName: 'Brightsphere Technologies (Pty) Ltd', isDefault: true },
  { companyId: VELOCITY, companyName: 'Velocity Fibre (Pty) Ltd', isDefault: false },
  { companyId: H10, companyName: 'H10 Holdings (Pty) Ltd', isDefault: false },
];

describe('resolveConsentCompany', () => {
  it('offers every membership as a choice, id and name only', () => {
    const choice = resolveConsentCompany(MEMBERSHIPS, VELOCITY);

    expect(choice?.companies).toEqual([
      { id: BRIGHTSPHERE, name: 'Brightsphere Technologies (Pty) Ltd' },
      { id: VELOCITY, name: 'Velocity Fibre (Pty) Ltd' },
      { id: H10, name: 'H10 Holdings (Pty) Ltd' },
    ]);
  });

  it('defaults to the active company when it is a membership', () => {
    expect(resolveConsentCompany(MEMBERSHIPS, VELOCITY)?.selectedCompanyId).toBe(VELOCITY);
    expect(resolveConsentCompany(MEMBERSHIPS, H10)?.selectedCompanyId).toBe(H10);
  });

  it('ignores an active company the user is not a member of — stale or tampered cookie', () => {
    const choice = resolveConsentCompany(MEMBERSHIPS, OUTSIDER);

    expect(choice?.selectedCompanyId).toBe(BRIGHTSPHERE); // the default membership
    expect(choice?.companies.map((c) => c.id)).not.toContain(OUTSIDER);
  });

  it('falls back to the default membership when no active company is set', () => {
    expect(resolveConsentCompany(MEMBERSHIPS, undefined)?.selectedCompanyId).toBe(BRIGHTSPHERE);
    expect(resolveConsentCompany(MEMBERSHIPS, '')?.selectedCompanyId).toBe(BRIGHTSPHERE);
  });

  it('falls back to the first membership when none is flagged default', () => {
    const noDefault = MEMBERSHIPS.map((m) => ({ ...m, isDefault: false }));

    expect(resolveConsentCompany(noDefault, undefined)?.selectedCompanyId).toBe(BRIGHTSPHERE);
  });

  it('returns null when the user has no company — caller must refuse consent', () => {
    expect(resolveConsentCompany([], BRIGHTSPHERE)).toBeNull();
  });

  it('handles a single-company user without offering a meaningless choice', () => {
    const solo = [MEMBERSHIPS[1]];

    const choice = resolveConsentCompany(solo, undefined);

    expect(choice?.companies).toHaveLength(1);
    expect(choice?.selectedCompanyId).toBe(VELOCITY);
  });
});
