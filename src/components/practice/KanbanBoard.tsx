/**
 * KanbanBoard — read-only job kanban with status transition popovers.
 * Columns: new → in_progress → review → approved → billed → complete → cancelled
 */

import { useState, useEffect, useRef } from 'react';
import type { PracticeJob } from '@/modules/accounting/services/practice/practiceJobService';
import { JobStatusBadge } from './JobStatusBadge';

export interface KanbanBoardProps {
  jobs: PracticeJob[];
  onTransition: (jobId: string, newStatus: PracticeJob['status']) => Promise<void>;
  onOpenJob?: (jobId: string) => void;
}

const ALLOWED: Record<PracticeJob['status'], PracticeJob['status'][]> = {
  new:         ['in_progress', 'cancelled'],
  in_progress: ['review', 'cancelled'],
  review:      ['in_progress', 'approved', 'cancelled'],
  approved:    ['billed', 'cancelled'],
  billed:      ['complete'],
  complete:    [],
  cancelled:   [],
};

const COLUMNS: PracticeJob['status'][] = [
  'new', 'in_progress', 'review', 'approved', 'billed', 'complete', 'cancelled',
];

const PRIORITY_DOT: Record<PracticeJob['priority'], string> = {
  low:    'bg-slate-400',
  normal: 'bg-blue-400',
  high:   'bg-amber-400',
  urgent: 'bg-rose-500',
};

const PRIORITY_LABEL: Record<PracticeJob['priority'], string> = {
  low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
};

const COL_HEADER: Record<PracticeJob['status'], string> = {
  new: 'New', in_progress: 'In Progress', review: 'Review',
  approved: 'Approved', billed: 'Billed', complete: 'Complete', cancelled: 'Cancelled',
};

function isOverdue(job: PracticeJob): boolean {
  if (!job.dueDate) return false;
  if (job.status === 'complete' || job.status === 'cancelled') return false;
  return new Date(job.dueDate) < new Date();
}

function JobCard({
  job,
  openPopoverId,
  setOpenPopoverId,
  onTransition,
  onOpenJob,
}: {
  job: PracticeJob;
  openPopoverId: string | null;
  setOpenPopoverId: (id: string | null) => void;
  onTransition: KanbanBoardProps['onTransition'];
  onOpenJob?: (id: string) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const isOpen = openPopoverId === job.id;
  const allowed = ALLOWED[job.status];
  const overdue = isOverdue(job);

  useEffect(() => {
    if (!isOpen) return;
    function handler(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenPopoverId(null);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, setOpenPopoverId]);

  async function handleTransition(newStatus: PracticeJob['status']) {
    setOpenPopoverId(null);
    await onTransition(job.id, newStatus);
  }

  return (
    <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-3 space-y-2 shadow-sm">
      <div className="flex items-start justify-between gap-1">
        <button
          onClick={() => onOpenJob?.(job.id)}
          className="text-sm font-medium text-[var(--ff-text-primary)] hover:text-teal-400 text-left leading-snug"
        >
          {job.title}
        </button>
        <span
          className={`mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 ${PRIORITY_DOT[job.priority]}`}
          title={PRIORITY_LABEL[job.priority]}
        />
      </div>
      {job.practiceClientName && (
        <p className="text-xs text-[var(--ff-text-secondary)] truncate">{job.practiceClientName}</p>
      )}
      {job.dueDate && (
        <p className={`text-xs ${overdue ? 'text-amber-400 font-medium' : 'text-[var(--ff-text-tertiary)]'}`}>
          Due {job.dueDate}{overdue ? ' — overdue' : ''}
        </p>
      )}
      {allowed.length > 0 && (
        <div ref={popoverRef} className="relative">
          <button
            onClick={() => setOpenPopoverId(isOpen ? null : job.id)}
            className="text-xs px-2 py-0.5 rounded border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors"
          >
            Transition ▾
          </button>
          {isOpen && (
            <div className="absolute left-0 top-full mt-1 z-20 min-w-[140px] rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] shadow-lg py-1">
              {allowed.map((s) => (
                <button
                  key={s}
                  onClick={() => void handleTransition(s)}
                  className="w-full text-left px-3 py-1.5 text-xs text-[var(--ff-text-secondary)] hover:bg-teal-500/10 hover:text-teal-400 transition-colors"
                >
                  <JobStatusBadge status={s} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function KanbanBoard({ jobs, onTransition, onOpenJob }: KanbanBoardProps) {
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null);

  const grouped = new Map<PracticeJob['status'], PracticeJob[]>(
    COLUMNS.map((col) => [col, []]),
  );
  for (const job of jobs) {
    grouped.get(job.status)?.push(job);
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 min-h-0">
      {COLUMNS.map((col) => {
        const colJobs = grouped.get(col) ?? [];
        return (
          <div key={col} className="flex-shrink-0 w-52 flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <JobStatusBadge status={col} />
              <span className="text-xs text-[var(--ff-text-tertiary)] font-medium">{colJobs.length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {colJobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[var(--ff-border-primary)] py-4 text-center">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">{COL_HEADER[col]}</p>
                </div>
              ) : (
                colJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    openPopoverId={openPopoverId}
                    setOpenPopoverId={setOpenPopoverId}
                    onTransition={onTransition}
                    onOpenJob={onOpenJob}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
