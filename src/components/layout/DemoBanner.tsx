// src/components/layout/DemoBanner.tsx
//
// Persistent amber bar shown across the whole app while the user has the
// seeded "ISAFlow Demo" company active. Stops users from confusing demo
// data with their real books and gives them a one-click escape back to
// their own company (or to onboarding if they don't have one yet).

import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

/**
 * Read the demo flag defensively. The `Company` interface has `isDemo`, but
 * the runtime payload sometimes flows in as the snake_case `is_demo` from
 * older cached responses or the `/api/accounting/companies` shape — guard
 * for both.
 */
function readIsDemo(activeCompany: unknown): boolean {
  if (!activeCompany || typeof activeCompany !== 'object') return false;
  const c = activeCompany as { isDemo?: unknown; is_demo?: unknown; name?: unknown };
  if (c.isDemo === true) return true;
  if (c.is_demo === true) return true;
  // Last-resort fallback: name contains "demo". Covers the case where
  // CompanyContext hydrated from localStorage and dropped the boolean.
  return typeof c.name === 'string' && /demo/i.test(c.name);
}

export function DemoBanner() {
  const router = useRouter();
  const { activeCompany, companies, switchCompany } = useCompany();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDemo = readIsDemo(activeCompany);

  // First non-demo membership the user has. We prefer the row marked
  // `isDefault`, then fall back to the first company that isn't a demo.
  const realCompany = useMemo(() => {
    if (!isDemo) return null;
    const notDemo = companies.filter(c => !/demo/i.test(c.companyName));
    return notDemo.find(c => c.isDefault) ?? notDemo[0] ?? null;
  }, [companies, isDemo]);

  if (!isDemo) return null;

  async function handleSwitch() {
    if (!realCompany) return;
    setSwitching(true);
    setError(null);
    try {
      await switchCompany(realCompany.companyId);
      // Bring the user back to a neutral starting page so we don't leave
      // them on a deep demo URL that may not exist for their tenant.
      await router.push('/accounting');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch company');
      setSwitching(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-amber-500/15 border-b border-amber-500/30 text-amber-200 px-4 py-2 flex items-center justify-center gap-3 text-xs"
    >
      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-300" aria-hidden />
      <span className="text-center">
        <span className="font-semibold uppercase tracking-wider mr-2 text-[10px]">Demo</span>
        You are viewing <span className="font-medium text-amber-100">ISAFlow Demo</span>.
        All data is illustrative; nothing posts to real books.
      </span>

      {realCompany ? (
        <button
          type="button"
          onClick={() => { void handleSwitch(); }}
          disabled={switching}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium border border-amber-400/40 disabled:opacity-50"
        >
          {switching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ArrowRight className="h-3 w-3" />
          )}
          Back to {realCompany.companyName}
        </button>
      ) : (
        <Link
          href="/onboarding"
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 font-medium border border-amber-400/40"
        >
          <ArrowRight className="h-3 w-3" />
          Set up your own company
        </Link>
      )}

      {error && (
        <span role="alert" className="text-amber-100 italic">
          {error}
        </span>
      )}
    </div>
  );
}
