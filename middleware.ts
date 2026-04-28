/**
 * Next.js Edge Middleware
 * - admin.isaflow.co.za: serve /admin/* pages with super_admin auth verification
 * - app.isaflow.co.za: redirect / to /accounting (app domain — no landing page)
 * - isaflow.co.za: show landing page at /
 * - Redirects /admin/* on non-admin hosts to admin.isaflow.co.za
 * - Redirects unauthenticated /accounting/* and /payroll/* requests to /login
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { CSRF_COOKIE, generateCsrfToken } from './src/lib/auth/csrf';

/** Issue the CSRF cookie on a response if it is not already present. */
function issueCsrfCookie(request: NextRequest, response: NextResponse): NextResponse {
  if (!request.cookies.get(CSRF_COOKIE)) {
    response.cookies.set(CSRF_COOKIE, generateCsrfToken(), {
      httpOnly: false,  // JS must read to mirror into X-CSRF-Token header
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  }
  return response;
}

// Auth cookie is GoTrue's sb-access-token across both app and admin hosts.
// The legacy custom-auth isaflow_auth is fully retired post-Phase-3a.
const AUTH_COOKIE_NAME = 'sb-access-token';

const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/register',
  '/onboarding',
  '/api/onboarding',
  '/invite',
  '/api/invite',
  '/accounting/afs/sign/',
  '/audit-portal',
  '/api/audit-portal',
];

/** Hostnames that should skip the landing page and go straight to the app */
const APP_HOSTS = ['app.isaflow.co.za'];

/** Hostnames that serve the /admin platform */
const ADMIN_HOSTS = ['admin.isaflow.co.za'];

/** Paths that bypass auth checks on the admin subdomain.
 *  NOTE: '/api/' routes pass through without rewriting (they use withAdmin
 *  middleware on each handler for auth). Only page paths get rewritten. */
const ADMIN_PASSTHROUGH = [
  '/_next',
  '/login',
  '/register',
  '/favicon.ico',
  '/icons',
  '/manifest.json',
  '/sw.js',
];

const ADMIN_URL = process.env.NEXT_PUBLIC_ADMIN_URL ?? 'https://admin.isaflow.co.za';
const CANONICAL_ADMIN_URL = 'https://admin.isaflow.co.za';

export function getAdminRedirectBase(
  adminUrl = ADMIN_URL,
  nodeEnv = process.env.NODE_ENV,
): string {
  if (nodeEnv !== 'production') {
    return adminUrl;
  }

  try {
    const parsedAdminUrl = new URL(adminUrl);
    if (
      parsedAdminUrl.protocol !== 'https:' ||
      parsedAdminUrl.hostname !== 'admin.isaflow.co.za'
    ) {
      return CANONICAL_ADMIN_URL;
    }
    return parsedAdminUrl.origin;
  } catch {
    // URL constructor threw: NEXT_PUBLIC_ADMIN_URL is malformed (e.g. missing scheme).
    // Edge runtime cannot reach @/lib/logger. validateEnv.ts catches this at boot in
    // production. This is a deliberate fail-closed guard — not an accidental swallow.
    return CANONICAL_ADMIN_URL;
  }
}

// Edge middleware gates admin-subdomain page navigation by cookie presence only.
// Real super_admin enforcement lives in withPlatformAdmin (src/lib/auth/withPlatformAdmin.ts)
// on every admin API handler, which does a two-pool fail-closed role check against
// users.role via RLS. Edge can't do DB lookups; the JWT has no role claim
// (GoTrue user_metadata doesn't surface users.role), so edge verification would
// be strictly signature-shape and add no real security over cookie-presence.

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host')?.split(':')[0] ?? '';

  const isAdminHost = ADMIN_HOSTS.includes(host);

  // ── /api/admin/* host gate (pentest M20) ─────────────────────────────────────
  // Defence-in-depth behind per-handler `withAdmin` wrappers: block any
  // admin API call that comes in on a non-admin host. Prevents a future
  // admin handler shipped without the wrapper from being reachable via
  // app.isaflow.co.za. Localhost (dev) is allowed through.
  if (pathname.startsWith('/api/admin/') && !isAdminHost && host !== 'localhost') {
    return new NextResponse(
      JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Admin API only available on admin host' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // ── Admin subdomain handling ─────────────────────────────────────────────────
  if (isAdminHost) {
    // Always passthrough for static assets, login page, and API routes
    // API routes must not be rewritten — they live at /api/*, not /admin/api/*
    if (
      ADMIN_PASSTHROUGH.some(p => pathname.startsWith(p)) ||
      pathname.startsWith('/api/') ||
      pathname.match(/\.\w+$/)  // static files (logo.png, etc.)
    ) {
      return NextResponse.next();
    }

    const adminToken = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    if (!adminToken) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('returnTo', pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Rewrite page paths: / → /admin, /companies → /admin/companies, etc.
    if (!pathname.startsWith('/admin')) {
      const rewrittenUrl = request.nextUrl.clone();
      rewrittenUrl.pathname = pathname === '/' ? '/admin' : `/admin${pathname}`;
      return issueCsrfCookie(request, NextResponse.rewrite(rewrittenUrl));
    }

    return issueCsrfCookie(request, NextResponse.next());
  }

  // ── Non-admin hosts: redirect /admin/* to admin subdomain ───────────────────
  if (pathname.startsWith('/admin')) {
    const adminPath = pathname.replace(/^\/admin/, '') || '/';
    return NextResponse.redirect(`${getAdminRedirectBase()}${adminPath}`);
  }

  // Allow public paths, static files, and API routes on main domains
  if (
    PUBLIC_PATHS.some(p => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/icons') ||
    pathname.startsWith('/landing') ||
    pathname === '/manifest.json' ||
    pathname === '/sw.js' ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  // app.isaflow.co.za: redirect root to /accounting.
  // Issue CSRF on the redirect response too (same reason as the onboarding
  // redirect below — without this, a fresh user landing on /
  // bounces to /accounting without a CSRF cookie).
  if (pathname === '/' && APP_HOSTS.includes(host)) {
    return issueCsrfCookie(request, NextResponse.redirect(new URL('/accounting', request.url)));
  }

  // Check for auth cookie on protected routes
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (!token && (pathname.startsWith('/accounting') || pathname.startsWith('/payroll'))) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect to onboarding if user hasn't completed it.
  // Issue the CSRF cookie on the redirect response too — without this, an
  // authenticated user whose first request lands on /accounting bounces to
  // /onboarding without ever receiving a CSRF cookie, and any state-changing
  // call afterward fails until they hit a passthrough page.
  if (token && !request.cookies.get('ff_onboarding_done')?.value) {
    if (pathname.startsWith('/accounting') || pathname.startsWith('/payroll')) {
      return issueCsrfCookie(request, NextResponse.redirect(new URL('/onboarding', request.url)));
    }
  }

  // Issue CSRF cookie on any authenticated pass-through
  if (token) {
    return issueCsrfCookie(request, NextResponse.next());
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
