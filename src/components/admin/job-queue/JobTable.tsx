/**
 * JobTable — renders the background jobs table with checkbox selection.
 */

import { Loader2, RotateCcw, CheckSquare, Square } from 'lucide-react';
import type { BackgroundJob } from '@/modules/accounting/services/core/jobQueueService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const fmtDate = (d: string | Date | null) => {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' });
};

export const fmtDuration = (start: string | Date | null, end: string | Date | null): string => {
  if (!start) return '—';
  const s = start instanceof Date ? start : new Date(start);
  const e = end ? (end instanceof Date ? end : new Date(end)) : new Date();
  const ms = e.getTime() - s.getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
};

export const payloadSummary = (payload: Record<string, unknown>): string => {
  const keys = Object.keys(payload);
  if (keys.length === 0) return '{}';
  const preview = keys.slice(0, 3).map(k => `${k}: ${String(payload[k]).slice(0, 20)}`).join(', ');
  return keys.length > 3 ? `${preview} …` : preview;
};

export const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-amber-500/10 text-amber-400 border border-amber-500/30',
  running:   'bg-blue-500/10 text-blue-400 border border-blue-500/30',
  completed: 'bg-teal-500/10 text-teal-400 border border-teal-500/30',
  failed:    'bg-red-500/10 text-red-400 border border-red-500/30',
  cancelled: 'bg-gray-500/10 text-gray-400 border border-gray-500/30',
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  jobs: BackgroundJob[];
  selectedIds: Set<string>;
  retrying: string | null;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onRetry: (id: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function JobTable({ jobs, selectedIds, retrying, onToggleRow, onToggleAll, onRetry }: Props) {
  const allSelected  = jobs.length > 0 && selectedIds.size === jobs.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const TH = 'text-left px-4 py-3 text-xs font-medium text-gray-400';

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-700">
            <th className="px-4 py-3 w-8">
              <button onClick={onToggleAll} className="text-gray-400 hover:text-white transition-colors">
                {allSelected || someSelected
                  ? <CheckSquare className={`h-4 w-4 ${allSelected ? 'text-blue-400' : 'text-blue-400/50'}`} />
                  : <Square className="h-4 w-4" />
                }
              </button>
            </th>
            {['Job Type', 'Company', 'Payload', 'Status', 'Attempts', 'Created', 'Duration', 'Actions'].map(h => (
              <th key={h} className={h === 'Attempts' ? `text-center px-4 py-3 text-xs font-medium text-gray-400` : TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700">
          {jobs.map(job => {
            const isSel = selectedIds.has(job.id);
            return (
              <tr
                key={job.id} onClick={() => onToggleRow(job.id)}
                className={`cursor-pointer transition-colors ${isSel ? 'bg-blue-500/5 hover:bg-blue-500/10' : 'hover:bg-gray-700/30'}`}
              >
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  <button onClick={() => onToggleRow(job.id)} className="text-gray-400 hover:text-white">
                    {isSel ? <CheckSquare className="h-4 w-4 text-blue-400" /> : <Square className="h-4 w-4" />}
                  </button>
                </td>
                <td className="px-4 py-3"><span className="font-mono text-xs text-blue-300">{job.job_type}</span></td>
                <td className="px-4 py-3 text-xs text-gray-400">
                  {job.company_id ? job.company_id.slice(0, 8) + '…' : <span className="italic">system</span>}
                </td>
                <td className="px-4 py-3 max-w-xs">
                  <span className="text-xs text-gray-300 font-mono truncate block" title={JSON.stringify(job.payload)}>
                    {payloadSummary(job.payload ?? {})}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-full capitalize ${STATUS_COLORS[job.status] ?? ''}`}>
                    {job.status}
                  </span>
                  {job.error_message && (
                    <p className="text-xs text-red-400 mt-0.5 max-w-xs truncate" title={job.error_message}>{job.error_message}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-center text-xs text-gray-300">{job.attempts}/{job.max_attempts}</td>
                <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmtDate(job.created_at)}</td>
                <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">{fmtDuration(job.started_at, job.completed_at)}</td>
                <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                  {job.status === 'failed' && (
                    <button
                      disabled={retrying === job.id} onClick={() => onRetry(job.id)}
                      className="flex items-center gap-1 text-xs px-2 py-1 bg-amber-600/20 hover:bg-amber-600/40 text-amber-400 rounded transition-colors disabled:opacity-50"
                    >
                      {retrying === job.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
