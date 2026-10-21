/**
 * Props of the /oauth/authorize consent page (pages/oauth/authorize.tsx).
 * Types only, so the page stays under the 300-line cap.
 */
import type { ConsentCompany } from '@/lib/auth/consentCompany';

export interface ConsentApp {
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  isVerified: boolean;
}

export interface AuthorizePageProps {
  ok: true;
  app: ConsentApp;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  /** RFC 8707 resource the client named (already validated), passed to consent. */
  resource: string | null;
  /** RFC 9207 `iss` for the cancel redirect; the metadata document's issuer. */
  issuer: string;
  /** Memberships this user may grant against — resolved server-side. */
  companies: ConsentCompany[];
  /** Pre-selected company (active company when it is a membership). */
  selectedCompanyId: string;
}

export interface AuthorizePageErrorProps {
  ok: false;
  error: string;
}
