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
 */
import { clearInvoiceDrafts } from '@/lib/invoiceDrafts';

export function clearTenantClientState(): void {
  if (typeof window === 'undefined') return;
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
