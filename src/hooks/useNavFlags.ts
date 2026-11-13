/**
 * The nav feature flags the active company has (`NAV_FLAGS`, budgets P6 spec §13.14), for `stripFlagNav`.
 *
 * One `/api/features/check` per flag per company per page load, shared by every nav that asks (the top bar, the
 * drawer, the sidebar, the module bar and the command palette mount together). Until the answer arrives, when it
 * fails, and outside a CompanyProvider the set is EMPTY: a flagged link stays hidden rather than flashing up for a
 * company that cannot use it. A failed check is not cached, so the next mount asks again.
 */
import { useEffect, useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { NAV_FLAGS } from '@/components/accounting/navSections/flagNav';

const NONE: ReadonlySet<string> = new Set();
const resolved = new Map<string, ReadonlySet<string>>();
const inFlight = new Map<string, Promise<ReadonlySet<string>>>();

async function checkFlag(code: string): Promise<boolean> {
  const res = await apiFetch(`/api/features/check?code=${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(`feature check ${code} answered ${res.status}`);
  const json = (await res.json()) as { data?: { enabled?: unknown } };
  return json.data?.enabled === true;
}

/** The company's enabled nav flags (cached per company for the page's life). */
export function loadNavFlags(companyId: string): Promise<ReadonlySet<string>> {
  const done = resolved.get(companyId);
  if (done) return Promise.resolve(done);
  const pending = inFlight.get(companyId);
  if (pending) return pending;
  const p = Promise.all(NAV_FLAGS.map(async (code) => ((await checkFlag(code)) ? code : null)))
    .then((codes) => {
      const set: ReadonlySet<string> = new Set(codes.filter((c): c is string => c !== null));
      resolved.set(companyId, set);
      return set;
    })
    .catch((error: unknown) => {
      log.warn('nav feature flags unavailable; flagged links stay hidden', { error: String(error) }, 'useNavFlags');
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
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useCompany().activeCompany?.id ?? null;
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('within a CompanyProvider'))) throw err;
    return null;
  }
}

export function useNavFlags(): ReadonlySet<string> {
  const companyId = useActiveCompanyIdOrNull();
  const [flags, setFlags] = useState<ReadonlySet<string>>(() => (companyId ? resolved.get(companyId) ?? NONE : NONE));
  useEffect(() => {
    if (!companyId) { setFlags(NONE); return; }
    let gone = false;
    void loadNavFlags(companyId).then((set) => { if (!gone) setFlags(set); });
    return () => { gone = true; };
  }, [companyId]);
  return flags;
}
