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
import { jwtVerify } from 'jose';

const AUTH_COOKIE_NAME = 'ff_auth_token';

// Sentinel used when JWT_SECRET is absent — any token verified against this will
// always fail the role check, giving defense-in-depth without crashing the edge runtime.
const MISSING_SECRET_SENTINEL = '__MIDDLEWARE_NO_SECRET__';

const getJWTSecret = (): Uint8Array => {
  const secret = process.env.JWT_SECRET;
  // Return sentinel instead of empty string so jwtVerify still runs but produces
  // a payload that cannot match a real token signed with the real secret.
  return new TextEncoder().encode(secret ?? MISSING_SECRET_SENTINEL);
};

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
];

/** Hostnames that should skip the landing page and go straight to the app */
const APP_HOSTS = ['app.isaflow.co.za'];

/** Hostnames that serve the /admin platform */
const ADMIN_HOSTS = ['admin.isaflow.co.za'];

/** Paths that bypass auth checks on the admin subdomain.
 *  NOTE: '/api/' is intentionally excluded — admin API routes must pass through
 *  the JWT check here (defense-in-depth alongside withAdmin on each handler).
 *  Only truly static/public paths are listed. */
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

async function verifyAdmin(token: string): Promise<boolean> {
  // Reject immediately if JWT_SECRET is not configured — never allow access
  // with a missing secret, regardless of what the token contains.
  if (!process.env.JWT_SECRET) return false;
  try {
    const { payload } = await jwtVerify(token, getJWTSecret());
    return payload.role === 'super_admin';
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host')?.split(':')[0] ?? '';

  const isAdminHost = ADMIN_HOSTS.includes(host);

  // ── Admin subdomain handling ─────────────────────────────────────────────────
  if (isAdminHost) {
    // Always passthrough for static assets, API routes, and login
    if (ADMIN_PASSTHROUGH.some(p => pathname.startsWith(p))) {
      return NextResponse.next();
    }

    // Verify super_admin auth for all other paths
    const adminToken = request.cookies.get(AUTH_COOKIE_NAME)?.value;
    if (!adminToken) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('returnTo', pathname);
      return NextResponse.redirect(loginUrl);
    }

    const isAdmin = await verifyAdmin(adminToken);
    if (!isAdmin) {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    // Rewrite path: / → /admin, /companies → /admin/companies, etc.
    if (!pathname.startsWith('/admin')) {
      const rewrittenUrl = request.nextUrl.clone();
      rewrittenUrl.pathname = pathname === '/' ? '/admin' : `/admin${pathname}`;
      return NextResponse.rewrite(rewrittenUrl);
    }

    return NextResponse.next();
  }

  // ── Non-admin hosts: redirect /admin/* to admin subdomain ───────────────────
  if (pathname.startsWith('/admin')) {
    const adminPath = pathname.replace(/^\/admin/, '') || '/';
    return NextResponse.redirect(`${ADMIN_URL}${adminPath}`);
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

  // app.isaflow.co.za: redirect root to /accounting
  if (pathname === '/' && APP_HOSTS.includes(host)) {
    return NextResponse.redirect(new URL('/accounting', request.url));
  }

  // Check for auth cookie on protected routes
  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (!token && (pathname.startsWith('/accounting') || pathname.startsWith('/payroll'))) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect to onboarding if user hasn't completed it
  if (token && !request.cookies.get('ff_onboarding_done')?.value) {
    if (pathname.startsWith('/accounting') || pathname.startsWith('/payroll')) {
      return NextResponse.redirect(new URL('/onboarding', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
