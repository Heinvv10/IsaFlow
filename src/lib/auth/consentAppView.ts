/**
 * What the consent screen is allowed to show about an app.
 *
 * An app nobody has vouched for does not get to decorate this screen.
 * `description`, `logoUrl` and `homepageUrl` are free text and free URLs chosen
 * by whoever registered the app, and they render as body copy, an image beside
 * the name, and a link. An unverified app could therefore display our own logo
 * and say "the official IsaFlow connector, verified by IsaFlow" — outweighing
 * the single line that says it is unverified.
 *
 * The name survives because it is policed (see reservedClientName.ts), and so
 * does the redirect origin, which is registered up front and checked before the
 * page renders. Those two are the fields an app cannot freely choose.
 *
 * Withheld on the SERVER, not hidden in the markup, so the values never reach
 * the browser. A logo URL that is never rendered is also never FETCHED — an
 * attacker cannot use the consent screen to collect the IP address and
 * user-agent of everyone who views it.
 */
export interface ConsentAppSource {
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  isVerified: boolean;
  isFirstParty: boolean;
}

export interface ConsentAppView {
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  isVerified: boolean;
}

export function consentAppView(app: ConsentAppSource): ConsentAppView {
  // First-party apps are marked through an authed path, never by
  // self-registration, so they are trusted for the same reason verified ones are.
  const trusted = app.isVerified || app.isFirstParty;
  return {
    name: app.name,
    description: trusted ? app.description : null,
    logoUrl: trusted ? app.logoUrl : null,
    homepageUrl: trusted ? app.homepageUrl : null,
    isVerified: app.isVerified,
  };
}
