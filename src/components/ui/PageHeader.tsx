/**
 * PageHeader — canonical page header used across all list/detail pages.
 *
 * Pattern B (icon-chip + title + subtitle + right-aligned actions + bottom border).
 * Use the <DashboardHero> component instead for top-level dashboard heroes.
 *
 * Usage:
 *   <PageHeader
 *     icon={Users}
 *     title="Customers"
 *     subtitle="Manage your customer accounts"
 *     actions={<Button leftIcon={Plus}>New Customer</Button>}
 *   />
 */

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface PageHeaderProps {
  /** Lucide icon shown in the chip on the left. */
  icon: LucideIcon;
  /** Page title (e.g. "Customers"). */
  title: string;
  /** One-line subtitle / description. */
  subtitle?: string;
  /** Right-aligned actions (CTA buttons, filters, etc.) */
  actions?: React.ReactNode;
  /** Optional back link / breadcrumb shown above the title. */
  backLink?: { label: string; href: string };
  /** Override the chip background colour. Defaults to teal-500/10. */
  chipColor?: string;
  /** Additional className on the wrapper. */
  className?: string;
}

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  backLink,
  chipColor = 'bg-teal-500/10 text-teal-500 dark:text-teal-400',
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('border-b border-slate-200 dark:border-slate-800 mb-6', className)}>
      <div className="px-6 py-5 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className={cn('p-2 rounded-lg shrink-0', chipColor)}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            {backLink && (
              <a
                href={backLink.href}
                className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors mb-1 inline-flex items-center gap-1"
              >
                ← {backLink.label}
              </a>
            )}
            <h1 className="text-xl font-semibold text-slate-900 dark:text-white truncate">{title}</h1>
            {subtitle && (
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
            )}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

PageHeader.displayName = 'PageHeader';
