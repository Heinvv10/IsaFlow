/**
 * Recovery for a session whose `active_company_id` cookie names a company the
 * server will no longer serve.
 *
 * Incident 2026-10-16: an admin soft-deleted a user's default company. Login
 * had already written that company into the cookie, `withAuth` refused it, and
 * every company-scoped call — including `GET /api/accounting/companies?action=
 * user-companies`, which the switcher's own list comes from — answered 403. The
 * provider was left with no active company AND no list to switch with, so the
 * UI had nothing to offer the user.
 *
 * The sign-in fixes (`src/lib/auth/liveCompanies.ts`) stop new sessions getting
 * into that state; this heals the ones already in it. `/api/auth/me` is
 * user-scoped (`withUserAuth`), so it still answers when the active company is
 * refused, and it now returns only memberships a session may be scoped to.
 *
 * Deliberately NOT a page reload: it re-points the cookie and lets the caller
 * re-run its normal load. The caller must also guard it to one attempt per
 * provider instance — if the switch does not fix things, the user gets the
 * "no company" screen, never a loop.
 */
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface MeMembership { company_id?: string; companyId?: string }

/**
 * Point the session at the user's first live company. Returns its id, or null
 * when there is nothing to recover to (no live membership, or either call
 * failed) — in which case the caller shows the "no company" state.
 */
export async function recoverActiveCompany(): Promise<string | null> {
  try {
    const meRes = await apiFetch('/api/auth/me');
    if (!meRes.ok) {
      log.warn('Active company recovery could not read the session', { status: meRes.status }, 'context');
      return null;
    }
    const me = await meRes.json() as { data?: { memberships?: MeMembership[] } };
    const first = (me.data?.memberships ?? [])[0];
    const companyId = first?.companyId ?? first?.company_id ?? null;
    if (!companyId) return null;

    const switchRes = await apiFetch('/api/auth/switch-company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId }),
    });
    if (!switchRes.ok) {
      log.warn('Active company recovery could not switch', { status: switchRes.status }, 'context');
      return null;
    }
    log.warn('Active company was no longer available — switched to a live company', { companyId }, 'context');
    return companyId;
  } catch (e) {
    log.warn('Active company recovery failed', { error: e }, 'context');
    return null;
  }
}
