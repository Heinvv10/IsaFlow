/**
 * Bureau Client Home (Level 2) — per-client triage for firm users.
 *
 * Reached from the /bureau/clients roster. Shows a glanceable metric strip
 * + a "needs you" feed of this one client's outstanding work. Clicking a row
 * switches the active company and drops into the deep task page to act.
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { ArrowLeft, AlertCircle, Loader2 } from 'lucide-react';
import { ClientHomeView } from '@/components/bureau/ClientHomeView';
import { bureauClientErrorMessage } from '@/components/bureau/clientHomeError';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import type { ClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';

interface ClientHomeData {
  company: { id: string; name: string; bureauName: string };
  metrics: ClientMetrics;
  workItems: WorkItem[];
}

export default function BureauClientHomePage() {
  const router = useRouter();
  const companyId = typeof router.query.companyId === 'string' ? router.query.companyId : '';
  const { switchCompany, activeCompany } = useCompany();
  const [data, setData] = useState<ClientHomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/bureau/client/${companyId}`);
      const json = await res.json() as { data?: ClientHomeData; error?: { message?: string }; message?: string };
      if (!res.ok) throw new Error(bureauClientErrorMessage(res.status, json));
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const handleOpen = async (item: WorkItem) => {
    if (activeCompany?.id !== item.companyId) {
      await switchCompany(item.companyId);
    }
    void router.push(item.href);
  };

  if (loading) {
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
        <div className="p-6 space-y-4">
          <Link href="/bureau/clients" className="inline-flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            <ArrowLeft className="h-4 w-4" /> Back to clients
          </Link>
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error || 'This client is not in your bureau.'}
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/bureau/clients" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">{data.company.name}</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">{data.company.bureauName}</p>
            </div>
          </div>
        </div>

        <ClientHomeView
          metrics={data.metrics}
          workItems={data.workItems}
          onOpenItem={(it) => void handleOpen(it)}
        />
      </div>
    </AppLayout>
  );
}
