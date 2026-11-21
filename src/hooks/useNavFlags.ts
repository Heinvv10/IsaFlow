/**
 * What the nav may show the active company and user (`NAV_FLAGS`), for `stripFlagNav`: the company's feature flags
 * (budgets P6 spec §13.14) and `moduleReadFlag(m)` for each module the user can read (Payroll).
 *
 * One `/api/features/check` per feature flag and one `/api/accounting/my-permissions` per company per page load,
 * shared by every nav that asks (the top bar, the drawer, the sidebar, the module bar and the command palette mount
 * together). Until the answers arrive, when either fails, and outside a CompanyProvider the set is EMPTY: a flagged
 * link and a module the user may not read stay hidden rather than flashing up and out. A failed check is not
 * cached, so the next mount asks again.
 */
import { useEffect, useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { FEATURE_NAV_FLAGS, moduleReadFlag, NAV_MODULES } from '@/components/accounting/navSections/flagNav';

const NONE: ReadonlySet<string> = new Set();
const resolved = new Map<string, ReadonlySet<string>>();
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
  const p = Promise.all([
    Promise.all(FEATURE_NAV_FLAGS.map(async (code) => ((await checkFlag(code)) ? code : null))),
    readableModuleFlags(),
  ])
    .then(([codes, modules]) => {
      const set: ReadonlySet<string> = new Set([...codes.filter((c): c is string => c !== null), ...modules]);
      resolved.set(companyId, set);
      return set;
    })
    .catch((error: unknown) => {
      log.warn('nav flags unavailable; flagged links and modules the user may not read stay hidden', { error: String(error) }, 'useNavFlags');
      return NONE;
    })
    .finally(() => inFlight.delete(companyId));
  inFlight.set(companyId, p);
  return p;
}

/** Test seam: forget every cached answer. */
export function resetNavFlagsCache(): void {
  resolved.clear();
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
  return companyId ? resolved.get(companyId) ?? NONE : NONE;
}
