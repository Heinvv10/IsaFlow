/**
 * InvoiceActionBar — Groups invoice detail page actions into labelled workflow sections.
 *
 * Groups are rendered as clustered button rows separated by a subtle divider.
 * Overflow / destructive actions go in the "More" kebab menu at the far right.
 *
 * Usage:
 *   <InvoiceActionBar
 *     groups={[
 *       { label: 'Send', actions: [...] },
 *       { label: 'Collect', actions: [...] },
 *       { label: 'Accounting', actions: [...] },
 *     ]}
 *     overflowActions={[...]}
 *   />
 */

import * as React from 'react';
import { cn } from '@/utils/cn';
import { ActionMenu } from '@/components/ui/ActionMenu';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvoiceAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** 'primary' renders a filled button; 'secondary' renders an outlined button */
  variant?: 'primary' | 'secondary';
  /** Loading state — shows a spinner-like text prefix */
  loading?: boolean;
}

export interface InvoiceActionGroup {
  label: string;
  actions: InvoiceAction[];
}

export interface InvoiceActionBarProps {
  groups: InvoiceActionGroup[];
  /** Actions rendered in the More (kebab) overflow menu */
  overflowActions?: ActionMenuItem[];
  className?: string;
}

// ---------------------------------------------------------------------------
// Sub-component: single action button
// ---------------------------------------------------------------------------

function ActionButton({ action }: { action: InvoiceAction }) {
  const isSecondary = action.variant === 'secondary';

  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={action.disabled || action.loading}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50',
        'disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
        isSecondary
          ? 'border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] hover:text-[var(--ff-text-primary)]'
          : 'bg-blue-600 text-white hover:bg-blue-500',
      )}
    >
      {action.icon && (
        <span className="flex-shrink-0 h-4 w-4 flex items-center">{action.icon}</span>
      )}
      {action.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: labelled group of buttons
// ---------------------------------------------------------------------------

function ActionGroup({ group }: { group: InvoiceActionGroup }) {
  if (group.actions.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ff-text-tertiary)] px-0.5">
        {group.label}
      </span>
      <div className="flex items-center gap-1">
        {group.actions.map(action => (
          <ActionButton key={action.label} action={action} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component
// ---------------------------------------------------------------------------

export function InvoiceActionBar({ groups, overflowActions = [], className }: InvoiceActionBarProps) {
  const visibleGroups = groups.filter(g => g.actions.length > 0);

  return (
    <div className={cn('flex items-end gap-3', className)}>
      {visibleGroups.map((group, idx) => (
        <React.Fragment key={group.label}>
          {idx > 0 && (
            <div className="self-stretch border-l border-[var(--ff-border-light)] mt-4" aria-hidden="true" />
          )}
          <ActionGroup group={group} />
        </React.Fragment>
      ))}

      {overflowActions.length > 0 && (
        <>
          {visibleGroups.length > 0 && (
            <div className="self-stretch border-l border-[var(--ff-border-light)] mt-4" aria-hidden="true" />
          )}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ff-text-tertiary)] px-0.5">
              More
            </span>
            <ActionMenu items={overflowActions} triggerLabel="More invoice actions" />
          </div>
        </>
      )}
    </div>
  );
}
