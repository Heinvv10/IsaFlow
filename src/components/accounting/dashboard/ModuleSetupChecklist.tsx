/**
 * ModuleSetupChecklist — per-module setup progress, above the Home hero while
 * setup is open (the page loads it with useSetupProgress). A module collapses
 * once all of its tasks are done; the whole card hides when everything is done
 * (or the checklist could not be loaded).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle, ChevronDown, ChevronRight } from 'lucide-react';
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
        <span className="flex items-center gap-1 text-xs font-semibold text-[var(--ff-text-secondary)]">
          {module.complete && <CheckCircle2 className="h-3.5 w-3.5 text-brand-500" aria-hidden="true" />}
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
                <span className={task.done ? 'line-through' : ''}>{task.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ModuleSetupChecklist({ progress }: { progress: SetupProgress | null }) {
  // Nothing until loaded: a placeholder would shift the page when the card then hides.
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
