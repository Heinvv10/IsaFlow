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
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2 } from 'lucide-react';
import { ClientHomeView } from '@/components/bureau/ClientHomeView';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import type { ClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';

interface HomeData {
  metrics: ClientMetrics;
  workItems: WorkItem[];
}

export default function HomePage() {
  const router = useRouter();
  const { activeCompany, loading: companiesLoading } = useCompany();
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
      const json = await res.json() as { data?: HomeData; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompany?.id]);

  useEffect(() => { void load(); }, [load]);

  if (companiesLoading || (loading && !data)) {
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

        <ClientHomeView
          metrics={data.metrics}
          workItems={data.workItems}
          onOpenItem={(it) => void router.push(it.href)}
        />
      </div>
    </AppLayout>
  );
}
