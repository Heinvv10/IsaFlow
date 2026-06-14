// Security headers + Content-Security-Policy for IsaFlow.
//
// Extracted from next.config.js into a CJS module so the policy can be unit
// tested directly (tests/unit/config/securityHeaders.test.ts) without loading
// the Sentry-wrapped next.config.js.
//
// Pentest WS-5:
//  - M2 (agent5): connect-src/img-src no longer use the broad
//    `https://*.isaflow.co.za` wildcard — any (future/low-trust/compromised)
//    subdomain would otherwise be a CSP-trusted exfil/load target, which is
//    especially dangerous paired with the parent-domain auth cookies
//    (COOKIE_DOMAIN=.isaflow.co.za). We enumerate the exact subdomains the
//    browser actually talks to: app., admin. and (for client Sentry/Bugsink)
//    errors. The Next.js app is served on BOTH app. and admin. hosts, so each
//    needs both as connect/img sources.
//  - L3 (agent5): X-XSS-Protection: 0 added explicitly. `0` is the OWASP
//    recommendation — it disables the legacy, buggy XSS auditor; CSP is the
//    real defense.
//  - M1 (agent5): style-src still carries 'unsafe-inline'. This is a deliberate,
//    documented residual: the app uses dynamic inline style={{...}} attributes
//    in ~71 components (computed widths, overlay coordinates, charts), and CSP
//    nonces/hashes only apply to <style>/<link> ELEMENTS, never to inline style
//    ATTRIBUTES — so 'unsafe-inline' cannot be dropped without refactoring all
//    of them away from inline styles. The real XSS sink (script-src) is already
//    locked down in prod (no 'unsafe-inline'/'unsafe-eval'), so the residual
//    CSS-injection risk is low. Revisit via a dedicated refactor PR if desired.
//
// NOTE: M10 (agent5) — auth cookies are scoped to the parent domain via
// COOKIE_DOMAIN=.isaflow.co.za to enable app.<->admin. SSO (documented in
// docs/superpowers/specs/2026-04-18-admin-auth-gotrue-design.md). Changing that
// requires a JWT_SECRET rotation (see src/lib/auth/cookies.ts), so it is left
// as an accepted SSO tradeoff; this CSP tightening reduces its blast radius.

// External third-party providers that legitimately need their own subdomain
// wildcards (NOT the M2 *.isaflow.co.za concern):
const SAGE = 'https://*.sageone.co.za';
const CLOUDFLARE = 'https://*.cloudflare.com';
const CLOUDFLARE_INSIGHTS = 'https://cloudflareinsights.com';
const CLOUDFLARE_INSIGHTS_SCRIPT = 'https://static.cloudflareinsights.com';
const GRAVATAR = 'https://*.gravatar.com';
const SIGNUM = 'https://signum.brighttech.co.za';

// Exact IsaFlow hosts the browser is allowed to reach (replaces *.isaflow.co.za).
const ISAFLOW_APP = 'https://app.isaflow.co.za';
const ISAFLOW_ADMIN = 'https://admin.isaflow.co.za';
const ISAFLOW_ERRORS = 'https://errors.isaflow.co.za'; // Sentry/Bugsink ingest

/**
 * Build the Content-Security-Policy string.
 * @param {string} [nodeEnv] - process.env.NODE_ENV; 'production' uses the prod policy.
 * @returns {string}
 */
function buildCsp(nodeEnv) {
  const isProd = nodeEnv === 'production';

  // Pentest (prior): api.anthropic.com is NOT in connect-src — all Claude API
  // calls are server-side; the browser never speaks to it directly.
  const scriptSrc = isProd
    ? `script-src 'self' ${CLOUDFLARE_INSIGHTS_SCRIPT}`
    : `script-src 'self' 'unsafe-eval' 'unsafe-inline' ${CLOUDFLARE_INSIGHTS_SCRIPT}`;

  const connectSrc = isProd
    ? `connect-src 'self' ${SAGE} ${ISAFLOW_APP} ${ISAFLOW_ADMIN} ${ISAFLOW_ERRORS} ${CLOUDFLARE} ${CLOUDFLARE_INSIGHTS} ${CLOUDFLARE_INSIGHTS_SCRIPT}`
    : `connect-src 'self' ${SAGE} ${ISAFLOW_APP} ${ISAFLOW_ADMIN} ${ISAFLOW_ERRORS} ${CLOUDFLARE} ${CLOUDFLARE_INSIGHTS} http://localhost:3101 http://localhost:3004`;

  return [
    "default-src 'self'",
    scriptSrc,
    // style-src 'unsafe-inline' is required by dynamic inline style attributes — see header note above.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${ISAFLOW_APP} ${ISAFLOW_ADMIN} ${GRAVATAR}`,
    "font-src 'self' data:",
    connectSrc,
    `frame-src 'self' ${SIGNUM}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Build the full security header set applied to every route.
 * @param {string} [nodeEnv] - process.env.NODE_ENV.
 * @returns {{key: string, value: string}[]}
 */
function securityHeaders(nodeEnv) {
  return [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // L3: explicit `0` disables the legacy/buggy browser XSS auditor; CSP is the defense.
    { key: 'X-XSS-Protection', value: '0' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
    { key: 'X-DNS-Prefetch-Control', value: 'on' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
    { key: 'Content-Security-Policy', value: buildCsp(nodeEnv) },
  ];
}

module.exports = { buildCsp, securityHeaders };
