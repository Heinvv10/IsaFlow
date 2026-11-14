/**
 * Returns the URL prefix for admin routes based on the current hostname.
 * - On admin.isaflow.co.za: returns '' (clean paths like /companies)
 * - On app.isaflow.co.za or localhost: returns '/admin' (prefixed paths like /admin/companies)
 */

import { useState, useCallback } from 'react';

const ADMIN_HOSTS = ['admin.isaflow.co.za'];

/**
 * Read on the first render, not in an effect: an effect left the first frame with /admin/* hrefs on the admin host
 * (the drawer and the palette mount with links already drawn). The server has no hostname and renders '/admin';
 * nothing the admin pages render from this reaches the prerendered HTML, which is the auth skeleton.
 */
export function useAdminPrefix(): string {
  const [prefix] = useState(() => (isAdminSubdomain() ? '' : '/admin'));
  return prefix;
}

/**
 * Hook that returns a function to convert /admin/* paths to subdomain-aware paths.
 * Usage: const adminHref = useAdminHref();  adminHref('/admin/companies') → '/companies' on subdomain
 */
export function useAdminHref(): (path: string) => string {
  const prefix = useAdminPrefix();
  return useCallback(
    (path: string) => {
      const stripped = path.replace(/^\/admin/, '') || '/';
      return prefix ? `${prefix}${stripped === '/' ? '' : stripped}` : stripped;
    },
    [prefix],
  );
}

/** Check if we're on the admin subdomain (for use outside React) */
export function isAdminSubdomain(): boolean {
  if (typeof window === 'undefined') return false;
  return ADMIN_HOSTS.includes(window.location.hostname);
}

/** The tenant app, when this build was given no NEXT_PUBLIC_APP_URL. */
const TENANT_APP_ORIGIN = 'https://app.isaflow.co.za';

/**
 * Absolute URL of `path` (e.g. '/accounting?impersonate=...') in the tenant app. A relative URL is wrong on the
 * admin host: middleware rewrites every page there to /admin/*, so /accounting lands on /admin/accounting, a 404.
 * Order: the configured NEXT_PUBLIC_APP_URL; on the admin host the production app; elsewhere (dev, where the
 * console is /admin/* on the app's own origin) this origin.
 */
export function tenantAppUrl(path: string): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  const origin = configured || (isAdminSubdomain() ? TENANT_APP_ORIGIN : window.location.origin);
  return `${origin}${path}`;
}
