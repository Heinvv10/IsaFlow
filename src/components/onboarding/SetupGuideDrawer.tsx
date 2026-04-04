/**
 * SetupGuideDrawer — right-side onboarding checklist drawer.
 * Shows 9 setup categories with collapsible task lists and completion state.
 */

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, CheckCircle2, Circle, ExternalLink } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils/cn';
import { SETUP_CATEGORIES, TOTAL_TASK_COUNT, type SetupTask } from './setupGuideConfig';
import { DemoCompanyCTA } from './DemoCompanyCTA';

// ─── Props ───────────────────────────────────────────────────────────────────

interface SetupGuideDrawerProps {
  open: boolean;
  onClose: () => void;
  completedTasks: Set<string>;
  onMarkDone: (taskId: string) => void;
}

// ─── Task Row ────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: SetupTask;
  isDone: boolean;
  onMarkDone: (id: string) => void;
}

function TaskRow({ task, isDone, onMarkDone }: TaskRowProps) {
  return (
    <div className={cn(
      'flex items-start gap-3 py-2.5 px-3 rounded-lg group',
      'hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors',
    )}>
      {/* Status icon */}
      <div className="mt-0.5 flex-shrink-0">
        {isDone
          ? <CheckCircle2 className="w-4 h-4 text-teal-500" />
          : <Circle className="w-4 h-4 text-gray-300 dark:text-gray-600" />
        }
      </div>

      {/* Label + description */}
      <div className="flex-1 min-w-0">
        <Link
          href={task.href}
          className={cn(
            'text-sm font-medium inline-flex items-center gap-1',
            isDone
              ? 'line-through text-gray-400 dark:text-gray-500'
              : 'text-gray-800 dark:text-gray-200 hover:text-teal-600 dark:hover:text-teal-400',
          )}
        >
          {task.label}
          {!isDone && <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity" />}
        </Link>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-snug">
          {task.description}
        </p>
      </div>

      {/* Mark done button */}
      {!isDone && (
        <button
          onClick={() => onMarkDone(task.id)}
          className={cn(
            'flex-shrink-0 text-xs px-2 py-1 rounded border transition-colors',
            'border-gray-200 dark:border-gray-700',
            'text-gray-500 dark:text-gray-400',
            'hover:border-teal-400 hover:text-teal-600 dark:hover:text-teal-400',
            'opacity-0 group-hover:opacity-100',
          )}
          title="Mark as done"
        >
          Done
        </button>
      )}
    </div>
  );
}

// ─── Category Section ─────────────────────────────────────────────────────────

interface CategorySectionProps {
  categoryId: string;
  label: string;
  icon: React.ElementType;
  tasks: SetupTask[];
  completedTasks: Set<string>;
  onMarkDone: (taskId: string) => void;
  defaultOpen?: boolean;
}

function CategorySection({
  categoryId,
  label,
  icon: Icon,
  tasks,
  completedTasks,
  onMarkDone,
  defaultOpen = false,
}: CategorySectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const doneCount = tasks.filter(t => completedTasks.has(t.id)).length;
  const isComplete = doneCount === tasks.length;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
      {/* Category header */}
      <button
        onClick={() => setIsOpen(o => !o)}
        className={cn(
          'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors',
          'hover:bg-gray-50 dark:hover:bg-gray-800/50',
          isComplete && 'bg-teal-50/50 dark:bg-teal-900/10',
        )}
        aria-expanded={isOpen}
        aria-controls={`category-${categoryId}`}
      >
        {/* Icon */}
        <div className={cn(
          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          isComplete
            ? 'bg-teal-100 dark:bg-teal-900/40 text-teal-600 dark:text-teal-400'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
        )}>
          <Icon className="w-4 h-4" />
        </div>

        {/* Label + fraction */}
        <div className="flex-1 min-w-0">
          <span className={cn(
            'text-sm font-semibold',
            isComplete
              ? 'text-teal-700 dark:text-teal-300'
              : 'text-gray-900 dark:text-gray-100',
          )}>
            {label}
          </span>
          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
            {doneCount} of {tasks.length}
          </span>
        </div>

        {/* Chevron */}
        {isOpen
          ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
          : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
        }
      </button>

      {/* Task list */}
      {isOpen && (
        <div id={`category-${categoryId}`} className="px-2 pb-2 border-t border-gray-100 dark:border-gray-700/50">
          {tasks.map(task => (
            <TaskRow
              key={task.id}
              task={task}
              isDone={completedTasks.has(task.id)}
              onMarkDone={onMarkDone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Drawer ──────────────────────────────────────────────────────────────

export function SetupGuideDrawer({ open, onClose, completedTasks, onMarkDone }: SetupGuideDrawerProps) {
  const completedCount = completedTasks.size;
  const progressPct = TOTAL_TASK_COUNT > 0 ? Math.round((completedCount / TOTAL_TASK_COUNT) * 100) : 0;

  const handleMarkDone = useCallback((taskId: string) => {
    onMarkDone(taskId);
  }, [onMarkDone]);

  return (
    <Drawer open={open} onClose={onClose} title="Setup Guide" width="md">
      {/* Overall progress */}
      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Overall progress
          </span>
          <span className="text-sm font-semibold text-teal-600 dark:text-teal-400">
            {completedCount} of {TOTAL_TASK_COUNT} tasks
          </span>
        </div>
        <ProgressBar value={progressPct} color="teal" size="md" />
        {completedCount === TOTAL_TASK_COUNT && (
          <p className="mt-2 text-xs text-teal-600 dark:text-teal-400 font-medium">
            Setup complete — you are ready to go!
          </p>
        )}
      </div>

      {/* Category sections */}
      <div className="space-y-2">
        {SETUP_CATEGORIES.map((category, idx) => (
          <CategorySection
            key={category.id}
            categoryId={category.id}
            label={category.label}
            icon={category.icon}
            tasks={category.tasks}
            completedTasks={completedTasks}
            onMarkDone={handleMarkDone}
            defaultOpen={idx === 0}
          />
        ))}
      </div>

      {/* Demo company CTA */}
      <div className="mt-4">
        <DemoCompanyCTA message="Want to explore first? Try our demo company with sample data." />
      </div>

      {/* Footer */}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="ghost" size="sm" onClick={onClose} className="w-full">
          Close guide
        </Button>
      </div>
    </Drawer>
  );
}
