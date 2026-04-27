/**
 * Close Readiness Checklist
 *
 * Displays a 6-item advisory checklist for a selected fiscal period,
 * showing whether the period is ready to close. Each item shows pass / fail / warn
 * status with a "Fix" link to the relevant page when not passing.
 *
 * The checklist is ADVISORY only — it does not block the period close action.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type {
  CloseReadiness,
  ChecklistItem,
  ChecklistItemStatus,
} from '@/modules/accounting/services/gl/periodCloseReadinessService';

// ── Helpers ──────────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: ChecklistItemStatus }) {
  if (status === 'pass') return <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />;
  if (status === 'fail') return <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />;
  return <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />;
}

function statusRowClass(status: ChecklistItemStatus): string {
  if (status === 'pass') return 'border-slate-100 dark:border-slate-800';
  if (status === 'fail') return 'border-red-100 dark:border-red-900/40 bg-red-50/30 dark:bg-red-900/10';
  return 'border-amber-100 dark:border-amber-900/40 bg-amber-50/30 dark:bg-amber-900/10';
}

function OverallBanner({
  status,
  failCount,
  warnCount,
}: {
  status: ChecklistItemStatus;
  failCount: number;
  warnCount: number;
}) {
  if (status === 'pass') {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
        <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
        <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
          Ready to close — all checks passed.
        </p>
      </div>
    );
  }

  if (status === 'fail') {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
        <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0" />
        <p className="text-sm font-semibold text-red-700 dark:text-red-400">
          Cannot close — {failCount} issue{failCount !== 1 ? 's' : ''} must be resolved
          {warnCount > 0 ? ` (${warnCount} warning${warnCount !== 1 ? 's' : ''})` : ''}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
      <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
        {warnCount} warning{warnCount !== 1 ? 's' : ''} to review before closing.
      </p>
    </div>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 border-b last:border-b-0 ${statusRowClass(item.status)}`}
    >
      <StatusIcon status={item.status} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{item.label}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{item.reason}</p>
      </div>
      {item.status !== 'pass' && (
        <Link
          href={item.fixHref}
          className="flex-shrink-0 text-xs font-semibold text-teal-600 dark:text-teal-400 hover:underline"
        >
          Fix
        </Link>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

interface Props {
  periodId: string;
  periodName: string;
}

interface ApiShape {
  data?: CloseReadiness;
  error?: { message?: string };
}

export function CloseReadinessChecklist({ periodId, periodName }: Props) {
  const [readiness, setReadiness] = useState<CloseReadiness | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/accounting/fiscal-periods/${encodeURIComponent(periodId)}/close-readiness`,
      );
      const json = (await res.json()) as ApiShape;
      if (!res.ok) {
        throw new Error(json.error?.message ?? 'Failed to load checklist');
      }
      setReadiness(json.data ?? null);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to load close-readiness checklist';
      log.error('Close readiness load failed', { error: err, periodId }, 'accounting-ui');
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  const failCount = readiness?.items.filter(i => i.status === 'fail').length ?? 0;
  const warnCount = readiness?.items.filter(i => i.status === 'warn').length ?? 0;

  return (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            Close Readiness
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{periodName}</p>
        </div>
        <button
          onClick={() => void load()}
          disabled={isLoading}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors disabled:opacity-40"
          title="Refresh checklist"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        </div>
      )}

      {!isLoading && error && (
        <div className="px-4 py-4">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-2 text-xs font-semibold text-teal-600 dark:text-teal-400 hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && readiness && (
        <div>
          <div className="px-4 pt-3 pb-2">
            <OverallBanner
              status={readiness.overallStatus}
              failCount={failCount}
              warnCount={warnCount}
            />
          </div>
          <div className="border-t border-slate-100 dark:border-slate-800">
            {readiness.items.map(item => (
              <ChecklistRow key={item.key} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
