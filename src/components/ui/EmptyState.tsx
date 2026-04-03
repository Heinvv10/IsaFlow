/**
 * EmptyState — centered empty-state block with an icon, title, description,
 * and optional primary / secondary action buttons.
 *
 * Usage:
 *   <EmptyState
 *     icon={FileText}
 *     title="No invoices yet"
 *     description="Create your first invoice to get started."
 *     primaryAction={{ label: 'New Invoice', onClick: () => router.push('/accounting/customer-invoices/new') }}
 *     secondaryAction={{ label: 'Import from Sage', href: '/accounting/migration' }}
 *   />
 */

import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/utils/cn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActionButton {
  label: string;
  onClick?: () => void;
  href?: string;
}

interface EmptyStateProps {
  /** Lucide icon component rendered at the top */
  icon: LucideIcon;
  title: string;
  description?: string;
  primaryAction?: ActionButton;
  secondaryAction?: ActionButton;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ActionLink({ action, primary }: { action: ActionButton; primary: boolean }) {
  const base = cn(
    'inline-flex items-center justify-center px-4 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
    primary
      ? 'bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-500 dark:hover:bg-teal-600'
      : 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
  );

  if (action.href) {
    return (
      <Link href={action.href} className={base}>
        {action.label}
      </Link>
    );
  }

  return (
    <button type="button" onClick={action.onClick} className={base}>
      {action.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// WORKING: Pure presentational component — no state
export function EmptyState({
  icon: Icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-16 px-6',
        className
      )}
    >
      {/* Icon container */}
      <div className="mb-4 flex items-center justify-center w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800">
        <Icon className="w-8 h-8 text-gray-400 dark:text-gray-500" strokeWidth={1.5} />
      </div>

      {/* Text */}
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {title}
      </h3>
      {description && (
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs leading-relaxed">
          {description}
        </p>
      )}

      {/* Actions */}
      {(primaryAction || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {primaryAction && <ActionLink action={primaryAction} primary />}
          {secondaryAction && <ActionLink action={secondaryAction} primary={false} />}
        </div>
      )}
    </div>
  );
}
