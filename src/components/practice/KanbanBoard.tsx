/**
 * KanbanBoard — drag-and-drop job kanban via @dnd-kit/core.
 * Invalid drops rejected visually (column greyed out) and by server.
 */
import { useState, useEffect, useRef } from 'react';
import {
  DndContext, DragOverlay, useDraggable, useDroppable,
  PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
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
  low: 'bg-slate-400', normal: 'bg-blue-400', high: 'bg-amber-400', urgent: 'bg-rose-500',
};
const PRIORITY_LABEL: Record<PracticeJob['priority'], string> = {
  low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
};

function isOverdue(job: PracticeJob): boolean {
  if (!job.dueDate || job.status === 'complete' || job.status === 'cancelled') return false;
  return new Date(job.dueDate) < new Date();
}

// ─── Card content (shared between board card and DragOverlay) ────────────────

function JobCardContent({ job, isDragging = false }: { job: PracticeJob; isDragging?: boolean }) {
  const overdue = isOverdue(job);
  return (
    <div className={`rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-3 space-y-2 shadow-sm select-none ${isDragging ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-1">
        <span className="text-sm font-medium text-[var(--ff-text-primary)] leading-snug">{job.title}</span>
        <span className={`mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 ${PRIORITY_DOT[job.priority]}`} title={PRIORITY_LABEL[job.priority]} />
      </div>
      {job.practiceClientName && (
        <p className="text-xs text-[var(--ff-text-secondary)] truncate">{job.practiceClientName}</p>
      )}
      {job.dueDate && (
        <p className={`text-xs ${overdue ? 'text-amber-400 font-medium' : 'text-[var(--ff-text-tertiary)]'}`}>
          Due {job.dueDate}{overdue ? ' — overdue' : ''}
        </p>
      )}
      <div className="pt-0.5"><JobStatusBadge status={job.status} /></div>
    </div>
  );
}

// ─── Draggable card ──────────────────────────────────────────────────────────

function JobCard({ job, onOpenJob }: { job: PracticeJob; onOpenJob?: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: job.id,
    data: { fromStatus: job.status },
  });
  const pointerDown = useRef<{ x: number; y: number } | null>(null);

  function handlePointerDown(e: React.PointerEvent) {
    pointerDown.current = { x: e.clientX, y: e.clientY };
  }
  function handlePointerUp(e: React.PointerEvent) {
    if (!pointerDown.current) return;
    const dx = Math.abs(e.clientX - pointerDown.current.x);
    const dy = Math.abs(e.clientY - pointerDown.current.y);
    pointerDown.current = null;
    if (dx < 5 && dy < 5) onOpenJob?.(job.id);
  }

  return (
    <div
      ref={setNodeRef} {...listeners} {...attributes}
      onPointerDown={handlePointerDown} onPointerUp={handlePointerUp}
      className={isDragging ? 'cursor-grabbing' : 'cursor-grab'}
    >
      <JobCardContent job={job} isDragging={isDragging} />
    </div>
  );
}

// ─── Droppable column ────────────────────────────────────────────────────────

function Column({
  status, colJobs, isAllowed, onOpenJob,
}: {
  status: PracticeJob['status'];
  colJobs: PracticeJob[];
  isAllowed: boolean;
  onOpenJob?: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, data: { status } });
  return (
    <div className={`flex-shrink-0 w-52 flex flex-col gap-2 transition-opacity ${!isAllowed ? 'opacity-40 pointer-events-none' : 'opacity-100'}`}>
      <div className="flex items-center justify-between px-1">
        <JobStatusBadge status={status} />
        <span className="text-xs text-[var(--ff-text-tertiary)] font-medium">{colJobs.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex flex-col gap-2 min-h-[80px] rounded-lg p-1 transition-all ${isOver && isAllowed ? 'ring-2 ring-blue-400 bg-blue-400/5' : ''}`}
      >
        {colJobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--ff-border-primary)] py-4 text-center">
            <p className="text-xs text-[var(--ff-text-tertiary)]">Drop here</p>
          </div>
        ) : colJobs.map((job) => (
          <JobCard key={job.id} job={job} onOpenJob={onOpenJob} />
        ))}
      </div>
    </div>
  );
}

// ─── Board ───────────────────────────────────────────────────────────────────

export function KanbanBoard({ jobs, onTransition, onOpenJob }: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeFromStatus, setActiveFromStatus] = useState<PracticeJob['status'] | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const grouped = new Map<PracticeJob['status'], PracticeJob[]>(COLUMNS.map((col) => [col, []]));
  for (const job of jobs) grouped.get(job.status)?.push(job);

  const activeJob = activeId ? (jobs.find((j) => j.id === activeId) ?? null) : null;

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { fromStatus: PracticeJob['status'] } | undefined;
    setActiveId(String(event.active.id));
    setActiveFromStatus(data?.fromStatus ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setActiveFromStatus(null);
    const { over, active } = event;
    if (!over) return;
    const fromStatus = (active.data.current as { fromStatus: PracticeJob['status'] } | undefined)?.fromStatus;
    const toStatus = over.id as PracticeJob['status'];
    if (!fromStatus || fromStatus === toStatus) return;
    if (!ALLOWED[fromStatus].includes(toStatus)) {
      setLastError(`Cannot move from ${fromStatus} to ${toStatus}`);
      return;
    }
    void onTransition(String(active.id), toStatus);
  }

  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(() => setLastError(null), 3000);
    return () => clearTimeout(t);
  }, [lastError]);

  return (
    <div className="flex flex-col gap-3 min-h-0">
      {lastError && (
        <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
          {lastError}
        </div>
      )}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4 min-h-0">
          {COLUMNS.map((col) => {
            const isAllowed = activeFromStatus === null
              || col === activeFromStatus
              || ALLOWED[activeFromStatus].includes(col);
            return (
              <Column
                key={col} status={col}
                colJobs={grouped.get(col) ?? []}
                isAllowed={isAllowed}
                onOpenJob={onOpenJob}
              />
            );
          })}
        </div>
        <DragOverlay>
          {activeJob && (
            <div className="cursor-grabbing rotate-1 shadow-xl">
              <JobCardContent job={activeJob} />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
