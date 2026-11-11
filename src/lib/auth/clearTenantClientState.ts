/**
 * Wipes per-tenant browser state so the next sign-in on this device cannot
 * inherit the previous user's active company. Called from every redirect-to-
 * /login path (explicit logout, 401-refresh-fail bounce, idle timeout, login
 * page mount) so the cross-tenant UI flash is impossible regardless of how
 * the user got back to the sign-in screen.
 *
 * Centralized here so adding a new tenant-scoped localStorage key only needs
 * one edit instead of five. That includes every unsaved invoice draft
 * (src/lib/invoiceDrafts.ts): a session that ends by expiry must not leave a
 * customer's invoice in this browser for the next user either.
 *
 * It also purges Cache Storage (clearTenantCacheStorage): an older service
 * worker cached tenant API responses and authenticated HTML keyed by URL only
 * (audit 11 Nov 2026), and those entries must not outlive the session.
 */
import { clearInvoiceDrafts } from '@/lib/invoiceDrafts';
import { log } from '@/lib/logger';

// Public, user-independent entries the worker precaches at install and cannot
// re-seed after sign-out (/offline is not a public path). Everything else goes.
const KEEP_PATHS = new Set(['/offline', '/manifest.json']);
const KEEP_PREFIXES = ['/_next/static/', '/icons/'];

function keepEntry(url: string): boolean {
  const { pathname } = new URL(url);
  return KEEP_PATHS.has(pathname) || KEEP_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Deletes every entry in IsaFlow's Cache Storage caches (`isaflow-*`) except
 * the public ones above. Never throws: a failure is logged and sign-out or the
 * company switch proceeds.
 */
export async function clearTenantCacheStorage(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const names = (await caches.keys()).filter((n) => n.startsWith('isaflow-'));
    await Promise.all(names.map(async (name) => {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      await Promise.all(requests.filter((r) => !keepEntry(r.url)).map((r) => cache.delete(r)));
    }));
  } catch (error) {
    log.warn('Could not clear tenant entries from Cache Storage', { error }, 'auth');
  }
}

export function clearTenantClientState(): void {
  if (typeof window === 'undefined') return;
  void clearTenantCacheStorage(); // fire-and-forget: never throws, and must not delay the redirect
  clearInvoiceDrafts(); // best-effort on its own: a storage that throws is reported, never raised
  try {
    localStorage.removeItem('isaflow_active_company');
    localStorage.removeItem('isaflow_impersonation');
    sessionStorage.clear();
  } catch {
    // localStorage / sessionStorage can throw in private mode or when the
    // origin is over quota — best-effort only, the redirect still proceeds.
  }
}
