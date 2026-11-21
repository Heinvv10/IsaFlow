/**
 * What the nav may show the active company and user (`NAV_FLAGS`), for `stripFlagNav`: the company's feature flags
 * (budgets P6 spec §13.14) and `moduleReadFlag(m)` for each module the user can read (Payroll).
 *
 * One `/api/features/check` per feature flag and one `/api/accounting/my-permissions` per company per page load,
 * shared by every nav that asks (the top bar, the drawer, the sidebar, the module bar and the command palette mount
 * together). Until the answers arrive, for whatever failed, and outside a CompanyProvider the set lacks it: a flagged
 * link and a module the user may not read stay hidden rather than flashing up and out. The two answers are
 * independent: if one fails, what the other said still applies (a failed permissions request hides Payroll only, a
 * failed feature check the flagged links only). A failed check is not cached for good: the first mount after `NAV_FLAGS_BACKOFF_MS` asks again, not every mount.
 */
import { useEffect, useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { FEATURE_NAV_FLAGS, moduleReadFlag, NAV_MODULES } from '@/components/accounting/navSections/flagNav';

const NONE: ReadonlySet<string> = new Set();
const resolved = new Map<string, ReadonlySet<string>>();
/** What arrived when one of the two answers failed: used on screen, never final (asked again after the backoff). */
const partial = new Map<string, { flags: ReadonlySet<string>; retryAfter: number }>();
/** After a partial answer the endpoints are left alone this long, so every mount (and a company switch back and forth) does not re-ask a failing one. */
export const NAV_FLAGS_BACKOFF_MS = 30_000;
const inFlight = new Map<string, Promise<ReadonlySet<string>>>();

async function checkFlag(code: string): Promise<boolean> {
  const res = await apiFetch(`/api/features/check?code=${encodeURIComponent(code)}`);
  await assertOk(res, 'Could not check which features are on for this company');
  const json = (await res.json()) as { data?: { enabled?: unknown } };
  return json.data?.enabled === true;
}

/** The `moduleReadFlag`s of the `NAV_MODULES` the signed-in user can read in the active company. */
async function readableModuleFlags(): Promise<string[]> {
  const res = await apiFetch('/api/accounting/my-permissions');
  await assertOk(res, 'Could not check which modules this user can read');
  const json = (await res.json()) as { data?: { modules?: Record<string, { read?: unknown } | undefined> } };
  return NAV_MODULES.filter((m) => json.data?.modules?.[m]?.read === true).map(moduleReadFlag);
}

/** The company's enabled nav flags (cached per company for the page's life). */
export function loadNavFlags(companyId: string): Promise<ReadonlySet<string>> {
  const done = resolved.get(companyId);
  if (done) return Promise.resolve(done);
  const pending = inFlight.get(companyId);
  if (pending) return pending;
  const waiting = partial.get(companyId);
  if (waiting && Date.now() < waiting.retryAfter) return Promise.resolve(waiting.flags);
  // Independent answers: a failed permissions request hides Payroll only, a failed feature check hides the flagged
  // links only. Whatever did arrive is used; a partial answer is not final: the first mount after the backoff asks again.
  const p = Promise.allSettled([
    Promise.all(FEATURE_NAV_FLAGS.map(async (code) => ((await checkFlag(code)) ? code : null))),
    readableModuleFlags(),
  ])
    .then((results) => {
      const found: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') found.push(...(r.value as Array<string | null>).filter((c): c is string => c !== null));
        else log.warn('nav flags partly unavailable; what it gates stays hidden', { error: String(r.reason) }, 'useNavFlags');
      }
      const set: ReadonlySet<string> = new Set(found);
      if (results.every((r) => r.status === 'fulfilled')) { resolved.set(companyId, set); partial.delete(companyId); }
      else partial.set(companyId, { flags: set, retryAfter: Date.now() + NAV_FLAGS_BACKOFF_MS });
      return set;
    })
    .finally(() => inFlight.delete(companyId));
  inFlight.set(companyId, p);
  return p;
}

/** Test seam: forget every cached answer. */
export function resetNavFlagsCache(): void {
  resolved.clear();
  partial.clear();
  inFlight.clear();
}

/** The active company's id, or null outside a CompanyProvider (a nav rendered on its own in a test or a shell). */
function useActiveCompanyIdOrNull(): string | null {
  try {
    // useCompany calls useContext first on every render and only then throws, so the hook order never changes.
    return useCompany().activeCompany?.id ?? null;
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('within a CompanyProvider'))) throw err;
    return null;
  }
}

export function useNavFlags(): ReadonlySet<string> {
  const companyId = useActiveCompanyIdOrNull();
  // Re-render when this company's answer lands; the flags themselves are read for the company on screen NOW, so a
  // company switch never shows the previous company's flags while the new check is in flight (review M4).
  const [, setAnswered] = useState(0);
  useEffect(() => {
    if (!companyId || resolved.has(companyId)) return;
    let gone = false;
    void loadNavFlags(companyId).then(() => { if (!gone) setAnswered((n) => n + 1); });
    return () => { gone = true; };
  }, [companyId]);
  return companyId ? resolved.get(companyId) ?? partial.get(companyId)?.flags ?? NONE : NONE;
}
