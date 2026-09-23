/**
 * The consent screen must not let an unvouched-for app decorate itself.
 *
 * description, logoUrl and homepageUrl are chosen by whoever registered the
 * app and render as body copy, an image beside the name, and a link — so an
 * unverified app could show our own logo and call itself "the official IsaFlow
 * connector, verified by IsaFlow", outweighing the one line saying it is not
 * verified. The name is policed and the redirect origin is registered; those
 * two stay.
 */
import { describe, it, expect } from 'vitest';
import { consentAppView } from '@/lib/auth/consentAppView';

const attacker = {
  name: 'Acme Sync',
  description: 'The official IsaFlow connector, verified by IsaFlow',
  logoUrl: 'https://evil.example/isaflow-logo.png',
  homepageUrl: 'https://isaflow.co.za',
  isVerified: false,
  isFirstParty: false,
};

describe('consentAppView', () => {
  it('withholds everything an unverified app supplied about itself', () => {
    const view = consentAppView(attacker);
    expect(view.description).toBeNull();
    expect(view.logoUrl).toBeNull();
    expect(view.homepageUrl).toBeNull();
  });

  // Withheld on the server, so the browser never requests the image: an
  // attacker cannot use the consent screen to collect the IP and user-agent of
  // everyone who views it.
  it('leaves no trace of the withheld values to leak', () => {
    expect(JSON.stringify(consentAppView(attacker))).not.toContain('evil.example');
    expect(JSON.stringify(consentAppView(attacker))).not.toContain('isaflow.co.za');
    expect(JSON.stringify(consentAppView(attacker))).not.toContain('official');
  });

  it('keeps the two fields the app cannot freely choose', () => {
    const view = consentAppView(attacker);
    expect(view.name).toBe('Acme Sync');
    expect(view.isVerified).toBe(false);
  });

  it('lets a verified app decorate itself as before', () => {
    const view = consentAppView({ ...attacker, name: 'Xero', isVerified: true });
    expect(view.description).toBe(attacker.description);
    expect(view.logoUrl).toBe(attacker.logoUrl);
    expect(view.homepageUrl).toBe(attacker.homepageUrl);
  });

  // First-party is set through an authed path, never by self-registration.
  it('treats a first-party app as trusted even when not verified', () => {
    const view = consentAppView({ ...attacker, isFirstParty: true });
    expect(view.description).toBe(attacker.description);
    expect(view.logoUrl).toBe(attacker.logoUrl);
    // ...but isVerified stays what the row says. Trusted enough to decorate is
    // not the same claim as verified: passing `trusted` through here would put
    // the "Verified" badge on a first-party app and suppress the amber
    // not-verified warning, both of which read off this one field.
    expect(view.isVerified).toBe(false);
  });
});
