/**
 * Bureau Dashboard — cross-client work-owed view for accountants.
 *
 * Lands accountants here on login: every client company in their bureau,
 * every overdue / due-soon task, sorted by severity. Click an item to
 * switch active company and jump straight to the right page.
 *
 * Direct (single-tenant) users get redirected to the regular dashboard
 * — they see no bureau UI at all.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import {
  Briefcase, AlertCircle, Loader2,
  Building2, Filter,
} from 'lucide-react';
import { Feed, ActionRow } from '@/components/ui';
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

interface BureauRef {
  id: string;
  name: string;
  ownerUserId: string;
  role: 'owner' | 'accountant' | 'viewer';
}

interface DashboardData {
  bureaus: BureauRef[];
  workItems: WorkItem[];
  stats: { overdue: number; dueSoon: number; info: number; total: number; monthEnd?: { closed: number; total: number } };
  companyCount?: number;
}

export default function BureauDashboardPage() {
  const router = useRouter();
  const { switchCompany, activeCompany } = useCompany();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bureauFilter, setBureauFilter] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<Severity | ''>('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/bureau');
      const json = await res.json() as { data?: DashboardData; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Redirect direct users away — they have no bureau memberships.
  useEffect(() => {
    if (data && data.bureaus.length === 0 && !loading) {
      router.replace('/accounting');
    }
  }, [data, loading, router]);

  const visibleItems = useMemo(() => {
    if (!data) return [];
    return data.workItems.filter((i) =>
      (!bureauFilter || i.bureauId === bureauFilter) &&
      (!severityFilter || i.severity === severityFilter)
    );
  }, [data, bureauFilter, severityFilter]);

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

  if (error) {
    return (
      <AppLayout>
        <div className="p-6">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!data || data.bureaus.length === 0) {
    return null; // redirecting
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Briefcase className="h-6 w-6 text-purple-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Bureau Dashboard</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {data.bureaus.length === 1
                    ? data.bureaus[0]!.name
                    : `${data.bureaus.length} practices`} · {data.companyCount ?? 0} client{(data.companyCount ?? 0) === 1 ? '' : 's'}
                </p>
              </div>
            </div>
            <Link href="/bureau/clients" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-surface-primary)] text-sm text-[var(--ff-text-primary)]">
              <Building2 className="h-4 w-4" /> Manage Clients
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Stats */}
          {/* 5 cols only at lg+; monthEnd is conditional, so the 2/2/1 wrap at md is acceptable */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            <StatCard label="Overdue"  value={data.stats.overdue}  color="text-red-400"     onClick={() => setSeverityFilter(severityFilter === 'overdue' ? '' : 'overdue')} active={severityFilter === 'overdue'} />
            <StatCard label="Due soon" value={data.stats.dueSoon}  color="text-amber-400"   onClick={() => setSeverityFilter(severityFilter === 'due_soon' ? '' : 'due_soon')} active={severityFilter === 'due_soon'} />
            <StatCard label="Open"     value={data.stats.info}     color="text-sky-400"     onClick={() => setSeverityFilter(severityFilter === 'info' ? '' : 'info')} active={severityFilter === 'info'} />
            <StatCard label="Total"    value={data.stats.total}    color="text-[var(--ff-text-primary)]" />
            {data.stats.monthEnd && (
              <StatCard
                label="Month-end"
                value={`${data.stats.monthEnd.closed}/${data.stats.monthEnd.total}`}
                color="text-purple-400"
                icon={<Building2 className="h-4 w-4 text-purple-400" />}
              />
            )}
          </div>

          {/* Bureau filter (only when user has 2+ bureaus) */}
          {data.bureaus.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Filter className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <button
                onClick={() => setBureauFilter('')}
                className={`px-3 py-1.5 rounded-full text-xs ${!bureauFilter ? 'bg-purple-500/20 text-purple-400' : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]'}`}
              >
                All bureaus
              </button>
              {data.bureaus.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setBureauFilter(bureauFilter === b.id ? '' : b.id)}
                  className={`px-3 py-1.5 rounded-full text-xs ${bureauFilter === b.id ? 'bg-purple-500/20 text-purple-400' : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]'}`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}

          {/* Work queue */}
          <Feed
            title="Work owed today"
            empty={
              data.stats.total === 0
                ? 'No outstanding work — every client is up to date.'
                : 'No items match these filters.'
            }
          >
            {visibleItems.map((it) => {
              const badge = SEVERITY_BADGE[it.severity];
              const Icon = badge.icon;
              return (
                <ActionRow
                  key={`${it.companyId}-${it.task}-${it.href}`}
                  onClick={() => void handleOpen(it)}
                  leading={
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>
                      <Icon className="h-3 w-3" /> {badge.label}
                    </span>
                  }
                  title={
                    <>
                      <span className="font-medium">{it.task}</span>
                      <span className="text-[var(--ff-text-tertiary)]"> · {it.companyName}</span>
                    </>
                  }
                  subtitle={
                    data.bureaus.length > 1
                      ? `${it.detail} · ${it.bureauName}`
                      : it.detail
                  }
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

function StatCard({ label, value, color, onClick, active, icon }: {
  label: string;
  value: number | string;
  color: string;
  onClick?: () => void;
  active?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{ borderRadius: 'var(--ff-card-radius)' }}
      className={`text-left p-4 border transition-colors ${active
        ? 'border-purple-500 bg-purple-500/5'
        : 'border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] ' + (onClick ? 'hover:bg-[var(--ff-bg-tertiary)] cursor-pointer' : 'cursor-default')}`}
    >
      <div className="text-xs text-[var(--ff-text-tertiary)]">{label}</div>
      <div className={`inline-flex items-center gap-1 text-2xl mt-1 ${color}`} style={{ fontFamily: 'var(--ff-num-font)' }}>
        {icon && <span aria-hidden="true">{icon}</span>}
        <span>{value}</span>
      </div>
    </button>
  );
}
