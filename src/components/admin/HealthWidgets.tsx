/**
 * System Health — shared types, status indicators, and card components.
 * Used by pages/admin/health.tsx
 */

import Link from 'next/link';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { CheckCircle2, AlertTriangle, XCircle, ChevronRight } from 'lucide-react';

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface DbHealth {
  status: 'ok' | 'error';
  latency_ms: number;
  size_mb: number;
  error?: string;
}

export interface JobQueueHealth {
  pending: number;
  running: number;
  failed: number;
  oldest_pending_age_minutes: number | null;
}

export interface EmailHealth {
  sent_24h: number;
  failed_24h: number;
  success_rate_percent: number;
}

export interface RecentError {
  id: string;
  action: string;
  target_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface SystemHealthData {
  db: DbHealth;
  job_queue: JobQueueHealth;
  email: EmailHealth;
  active_sessions_24h: number;
  trials: { expiring_in_7d: number };
  recent_errors: RecentError[];
  overall_status: 'healthy' | 'degraded' | 'critical';
  checked_at: string;
}

// ─── Status primitives ────────────────────────────────────────────────────────

export type StatusLevel = 'ok' | 'warn' | 'error';

export function StatusDot({ level }: { level: StatusLevel }) {
  const cls = { ok: 'bg-emerald-500', warn: 'bg-yellow-400', error: 'bg-red-500' }[level];
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls} flex-shrink-0`} />;
}

export function StatusBadge({ level, label }: { level: StatusLevel; label: string }) {
  const cfg = {
    ok:    { bg: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', Icon: CheckCircle2 },
    warn:  { bg: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',   Icon: AlertTriangle },
    error: { bg: 'bg-red-500/15 text-red-400 border-red-500/30',            Icon: XCircle },
  }[level];
  const { bg, Icon } = cfg;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${bg}`}>
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
  );
}

// ─── Overall status banner ────────────────────────────────────────────────────

type OverallStatus = SystemHealthData['overall_status'];

export function OverallStatusBar({ status }: { status: OverallStatus | null }) {
  if (!status) return null;
  const cfgMap: Record<OverallStatus, { bg: string; icon: React.ComponentType<{ className?: string }>; msg: string }> = {
    healthy:  { bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', icon: CheckCircle2, msg: 'All systems operational' },
    degraded: { bg: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',   icon: AlertTriangle, msg: 'Some systems degraded — review metrics below' },
    critical: { bg: 'bg-red-500/10 border-red-500/30 text-red-400',            icon: XCircle,       msg: 'Critical issue detected — immediate attention required' },
  };
  const { bg, icon: Icon, msg } = cfgMap[status];
  return (
    <div className={`flex items-center gap-3 px-5 py-3.5 rounded-xl border ${bg} text-sm font-medium mb-6`}>
      <Icon className="w-5 h-5 flex-shrink-0" />
      <span>{msg}</span>
    </div>
  );
}

// ─── Metric card ─────────────────────────────────────────────────────────────

interface MetricCardProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  status: StatusLevel;
  children: React.ReactNode;
  linkHref?: string;
  linkLabel?: string;
}

export function MetricCard({ title, icon: Icon, status, children, linkHref, linkLabel }: MetricCardProps) {
  const adminHref = useAdminHref();
  const borderCls = {
    ok:    'border-gray-200 dark:border-gray-700',
    warn:  'border-yellow-400/40',
    error: 'border-red-500/40',
  }[status];

  return (
    <div className={`bg-white dark:bg-gray-900 border ${borderCls} rounded-xl shadow-sm p-5 flex flex-col gap-4`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-teal-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
        </div>
        <StatusDot level={status} />
      </div>
      <div className="flex-1">{children}</div>
      {linkHref && linkLabel && (
        <Link
          href={adminHref(linkHref)}
          className="inline-flex items-center gap-1 text-xs text-teal-500 hover:text-teal-400 font-medium mt-auto"
        >
          {linkLabel} <ChevronRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

// ─── Stat cell ────────────────────────────────────────────────────────────────

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 font-medium uppercase tracking-wider mb-0.5">{label}</p>
      <p className="text-xl font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}
