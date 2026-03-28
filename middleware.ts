/**
 * Next.js Edge Middleware
 * - app.isaflow.co.za: redirect / to /accounting (app domain — no landing page)
 * - isaflow.co.za: show landing page at /
 * - Redirects unauthenticated /accounting/* requests to /login
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const AUTH_COOKIE_NAME = 'ff_auth_token';

const PUBLIC_PATHS = ['/login', '/register', '/api/auth/login', '/api/auth/logout', '/api/auth/register', '/onboarding', '/api/onboarding'];

/** Hostnames that should skip the landing page and go straight to the app */
const APP_HOSTS = ['app.isaflow.co.za'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host')?.split(':')[0] ?? '';

  // Allow public paths, static files, and API routes
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

  if (!token && pathname.startsWith('/accounting')) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Redirect to onboarding if user hasn't completed it
  if (token && !request.cookies.get('ff_onboarding_done')?.value) {
    if (pathname.startsWith('/accounting')) {
      return NextResponse.redirect(new URL('/onboarding', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/accounting/:path*', '/onboarding/:path*'],
};
