/**
 * ModuleSetupChecklist — per-module setup progress on the Home overview.
 * A module collapses once all of its tasks are done; the whole card hides
 * when everything is done (or the checklist cannot be loaded).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, ChevronDown, ChevronRight } from 'lucide-react';
import { apiJson, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Skeleton } from '@/components/ui/Skeleton';
import type { SetupModuleProgress, SetupProgress } from '@/modules/accounting/services/core/setupProgressService';

function ModuleSection({ module }: { module: SetupModuleProgress }) {
  const [open, setOpen] = useState(!module.complete);
  useEffect(() => { setOpen(!module.complete); }, [module.complete]);
  const panelId = `setup-${module.id}`;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="border-t border-[var(--ff-border-light)] first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-1 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--ff-text-primary)]">
          <Chevron className="h-4 w-4 text-[var(--ff-text-tertiary)]" aria-hidden="true" />
          {module.label}
        </span>
        <span
          className={`text-xs font-semibold ${module.complete ? 'text-brand-600 dark:text-brand-400' : 'text-[var(--ff-text-secondary)]'}`}
        >
          {module.complete ? 'Complete' : `${module.doneCount}/${module.totalCount}`}
        </span>
      </button>
      {open && (
        <ul id={panelId} className="pb-2 pl-7 space-y-1">
          {module.tasks.map((task) => (
            <li key={task.id}>
              <Link
                href={task.href}
                className="flex items-center gap-2 py-1 text-sm no-underline text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
              >
                {task.done
                  ? <CheckCircle2 className="h-4 w-4 text-brand-500" aria-label="Done" />
                  : <Circle className="h-4 w-4 text-[var(--ff-text-tertiary)]" aria-label="To do" />}
                <span className={task.done ? 'line-through opacity-70' : ''}>{task.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ModuleSetupChecklist() {
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiJson('/api/accounting/setup-checklist', undefined, 'Could not load the setup checklist - try again')
      .then((data) => { if (!cancelled) setProgress(data); })
      .catch((err) => log.error('Failed to load setup checklist', { error: apiErrorMessage(err, 'setup checklist') }, 'accounting-ui'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5" aria-busy="true">
        <Skeleton variant="heading" width="40%" />
        <Skeleton variant="text" count={3} className="mt-2" />
      </div>
    );
  }
  if (!progress || progress.allComplete) return null;

  return (
    <section
      aria-labelledby="setup-checklist-title"
      className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 id="setup-checklist-title" className="text-sm font-semibold text-[var(--ff-text-primary)]">Finish setting up</h3>
        <span className="text-xs text-[var(--ff-text-secondary)]">{progress.doneCount} of {progress.totalCount} done</span>
      </div>
      {progress.modules.map((m) => <ModuleSection key={m.id} module={m} />)}
    </section>
  );
}
