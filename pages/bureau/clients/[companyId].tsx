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
import { Card, Feed, ActionRow, Money } from '@/components/ui';
import { SEVERITY_BADGE } from '@/components/bureau/severityBadge';
import type { Severity } from '@/modules/bureau/services/bureauWorkTypes';

interface WorkItem {
  bureauId: string;
  bureauName: string;
  companyId: string;
  companyName: string;
  task: string;
  detail: string;
  dueAt: string | null;
  href: string;
  severity: Severity;
  amount?: number | null;
}

interface ClientMetrics {
  cash: number;
  ar: number;
  ap: number;
  revenueMtd: number;
  profitMtd: number;
}

interface ClientHomeData {
  company: { id: string; name: string; bureauName: string };
  metrics: ClientMetrics;
  workItems: WorkItem[];
}

const METRIC_CARDS: Array<{ key: keyof ClientMetrics; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'ar', label: 'Accounts Receivable' },
  { key: 'ap', label: 'Accounts Payable' },
  { key: 'revenueMtd', label: 'Revenue MTD' },
  { key: 'profitMtd', label: 'Profit MTD' },
];

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
      const json = await res.json() as { data?: ClientHomeData; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load');
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

        <div className="p-6 space-y-6">
          {/* Metric strip */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {METRIC_CARDS.map((m) => (
              <Card key={m.key}>
                <div className="text-xs text-[var(--ff-text-tertiary)]">{m.label}</div>
                <Money amount={data.metrics[m.key]} className="block text-2xl mt-1 text-[var(--ff-text-primary)]" />
              </Card>
            ))}
          </div>

          {/* Needs-you feed */}
          <Feed title="Needs you" empty="All caught up — nothing needs you.">
            {data.workItems.map((it) => {
              const badge = SEVERITY_BADGE[it.severity];
              const Icon = badge.icon;
              return (
                <ActionRow
                  key={`${it.task}-${it.href}`}
                  onClick={() => void handleOpen(it)}
                  leading={
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>
                      <Icon className="h-3 w-3" /> {badge.label}
                    </span>
                  }
                  title={<span className="font-medium">{it.task}</span>}
                  subtitle={it.detail}
                  amount={it.amount ?? null}
                  meta={it.dueAt ? new Date(it.dueAt).toLocaleDateString() : '—'}
                />
              );
            })}
          </Feed>
        </div>
      </div>
    </AppLayout>
  );
}
