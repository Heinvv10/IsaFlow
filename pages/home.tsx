/**
 * Direct-Client Home (Level 2) — the post-login landing for a non-bureau client.
 *
 * Shows the active company's glanceable metric strip + "needs you" feed via
 * /api/home (withAuth — the active company is the ownership gate). The active
 * company comes from CompanyContext; a multi-company direct client switches it
 * with the existing company switcher and this page re-fetches.
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { AlertCircle, Loader2 } from 'lucide-react';
import { ClientHomeView } from '@/components/bureau/ClientHomeView';
import { OwnerCashPanel } from '@/components/home/OwnerCashPanel';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import type { ClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';
import type { OwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';

interface HomeData {
  metrics: ClientMetrics;
  workItems: WorkItem[];
  cashPosition?: OwnerCashPosition;
}

export default function HomePage() {
  const router = useRouter();
  const { activeCompany, companies, loading: companiesLoading, switchCompany } = useCompany();
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Key on the primitive id, not the activeCompany object: CompanyContext enriches
  // the active-company stub after mount via setActiveCompany(newObject), changing
  // object identity but not the id — depending on .id avoids a guaranteed double-fetch.
  // Company switches trigger window.location.reload() in CompanyContext.switchCompany,
  // so this remounts and re-fetches /api/home with the new active-company header — no
  // extra dep tracking needed.
  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/home');
      await assertOk(res, 'Could not load the home page - try again');
      const json = await res.json() as { data?: HomeData; message?: string };
      setData(json.data ?? null);
    } catch (err) {
      setData(null);
      setError(apiErrorMessage(err, 'Could not load the home page - try again'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompany?.id]);

  useEffect(() => { void load(); }, [load]);

  if (companiesLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  // Company loading has FINISHED and there is still no active company — the
  // state the 2026-10-16 incident produced (the session's company had been
  // soft-deleted, so every company-scoped call 403'd). `load()` returns early
  // without an active company, so `loading` never clears: rendering the
  // spinner here spins forever. Say what happened and give a way out instead.
  if (!activeCompany) {
    return (
      <AppLayout>
        <div className="p-6">
          <div className="max-w-xl rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-6">
            <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">No company selected</h1>
            {companies.length > 0 ? (
              <>
                <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">
                  We couldn&apos;t open the company this session was pointed at — it may have been
                  removed. Choose one of your companies to carry on.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {companies.map((c) => (
                    <button
                      key={c.companyId}
                      type="button"
                      onClick={() => void switchCompany(c.companyId)}
                      className="rounded-lg border border-[var(--ff-border-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)]"
                    >
                      {c.companyName || c.companyId}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">
                  You don&apos;t have access to any company yet. Set one up to get started, or ask
                  whoever administers your account to invite you.
                </p>
                <button
                  type="button"
                  onClick={() => void router.push('/onboarding')}
                  className="mt-4 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
                >
                  Set up a company
                </button>
              </>
            )}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (loading && !data) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error || !data) {
    return (
      <AppLayout>
        <div className="p-6">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error || 'We couldn’t load your home right now. Please try again.'}
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
              {activeCompany?.name ?? 'My business'}
            </h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Here&apos;s what needs you today.</p>
          </div>
        </div>

        {data.cashPosition && (
          <div className="px-6 pt-6">
            <OwnerCashPanel position={data.cashPosition} />
          </div>
        )}

        <ClientHomeView
          metrics={data.metrics}
          workItems={data.workItems}
          onOpenItem={(it) => void router.push(it.href)}
        />
      </div>
    </AppLayout>
  );
}
