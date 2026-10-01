/**
 * Presentational pieces of the Sage migration page, split out to keep
 * pages/accounting/sage-migration/index.tsx under the 300-line cap.
 */
import { Loader2, CheckCircle2, Play, RotateCcw } from 'lucide-react';

export interface MigrationRunSummary {
  id: string; runType: string; status: string; totalRecords: number;
  succeeded: number; failed: number; skipped: number;
  startedAt: string; completedAt: string | null;
  /** Imported rows whose Sage source carried no VAT figure (R-089). */
  vatNotStated: number;
}

export interface MigrationStatus {
  accounts: { sageTotal: number; mapped: number; unmapped: number; autoMapped: number };
  ledger: { sageTotal: number; imported: number; pending: number; failed: number; dateRange: { earliest: string | null; latest: string | null } };
  invoices: { sageTotal: number; imported: number; pending: number; failed: number };
  lastRuns: MigrationRunSummary[];
}

export function MigrationHistory({ runs }: { runs: MigrationRunSummary[] }) {
  if (runs.length === 0) return null;
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
        <h3 className="font-semibold text-[var(--ff-text-primary)]">Migration History</h3>
      </div>
      <div className="divide-y divide-[var(--ff-border-light)]">
        {runs.map(run => (
          <div key={run.id} className="px-5 py-3 flex items-center justify-between text-sm">
            <div>
              <span className="font-medium text-[var(--ff-text-primary)]">{run.runType.replace('_', ' ')}</span>
              <span className="text-[var(--ff-text-tertiary)] text-xs ml-2">
                {new Date(run.startedAt).toLocaleDateString('en-ZA')}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--ff-text-secondary)]">
                {run.succeeded} ok / {run.failed} fail / {run.skipped} skip
                {run.vatNotStated > 0 && ` / ${run.vatNotStated} VAT not stated`}
              </span>
              <StatusBadge status={run.status} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StepCard({ step, icon, title, desc, status }: {
  step: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  status: 'waiting' | 'ready' | 'done';
}) {
  return (
    <div className="p-4 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]">
      <div className="flex items-center gap-2 mb-2">
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--ff-bg-secondary)] text-[var(--ff-text-tertiary)] text-xs font-bold">{step}</span>
        <span className="text-[var(--ff-text-tertiary)]">{icon}</span>
      </div>
      <p className="text-sm font-medium text-[var(--ff-text-primary)]">{title}</p>
      <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">{desc}</p>
      {status === 'waiting' && <p className="text-xs text-[var(--ff-text-tertiary)] mt-2 italic">Waiting for data</p>}
    </div>
  );
}

export function MigrationStep({ step, icon, title, desc, progress, complete, onRun, onReset, loading, runLabel, disabled, disabledReason }: {
  step: number;
  icon: React.ReactNode;
  title: string;
  desc: string;
  progress: number;
  complete: boolean;
  onRun: () => void;
  onReset: () => void;
  loading: boolean;
  runLabel: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold ${complete ? 'bg-teal-500/10 text-teal-400' : 'bg-blue-500/10 text-blue-400'}`}>
            {complete ? <CheckCircle2 className="h-4 w-4" /> : step}
          </div>
          <div>
            <h3 className="font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
              {icon} {title}
            </h3>
            <p className="text-xs text-[var(--ff-text-secondary)]">{desc}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onReset}
            className="p-2 rounded-lg text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-primary)] transition-colors"
            title="Reset"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <button
            onClick={onRun}
            disabled={loading || disabled}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-50"
            title={disabled ? disabledReason : undefined}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {runLabel}
          </button>
        </div>
      </div>
      <div className="h-2 rounded-full bg-[var(--ff-bg-primary)] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${complete ? 'bg-teal-500' : 'bg-blue-500'}`}
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-teal-500/20 text-teal-400',
    partial: 'bg-amber-500/20 text-amber-400',
    failed: 'bg-red-500/20 text-red-400',
    running: 'bg-blue-500/20 text-blue-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status}
    </span>
  );
}
