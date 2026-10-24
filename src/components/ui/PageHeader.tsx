/**
 * PageHeader — canonical page header used across all list/detail pages.
 *
 * Pattern B (icon-chip + title + breadcrumb/subtitle + right-aligned actions + bottom border).
 * Use the <DashboardHero> component instead for top-level dashboard heroes.
 *
 * Drawn only from theme tokens (header-band, ink, ink-muted, line), so it reads in both
 * themes. Do not give it a fixed dark background: the navy band that kept a dark title on a
 * white page is what this replaced.
 *
 * Usage:
 *   <PageHeader
 *     icon={Users}
 *     title="Customers"
 *     subtitle="Manage your customer accounts"
 *     actions={<Button leftIcon={Plus}>New Customer</Button>}
 *   />
 *   // breadcrumb instead of backLink:
 *   <PageHeader icon={BarChart3} title="Income Statement"
 *     breadcrumb={[{ label: 'Reports', href: '/accounting?tab=reports' }, { label: 'Income Statement' }]} />
 */

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb';

export interface PageHeaderProps {
  /** Lucide icon shown in the chip on the left. */
  icon: LucideIcon;
  /** Page title (e.g. "Customers"). */
  title: string;
  /** One-line subtitle / description. */
  subtitle?: string;
  /** Right-aligned actions (CTA buttons, filters, etc.) */
  actions?: React.ReactNode;
  /** Optional back link shown above the title. */
  backLink?: { label: string; href: string };
  /** Breadcrumb trail shown above the title; the last item is the current page. */
  breadcrumb?: BreadcrumbItem[];
  /** Override the chip background colour. Defaults to teal-500/10. */
  chipColor?: string;
  /** Additional className on the wrapper (`mb-0` when the content block brings its own padding). */
  className?: string;
}

export function PageHeader({
  icon: Icon,
  title,
  subtitle,
  actions,
  backLink,
  breadcrumb,
  chipColor = 'bg-teal-500/10 text-teal-700 dark:text-teal-400',
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('border-b border-line bg-header-band mb-6', className)}>
      <div className="px-6 py-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-[16rem] flex-1">
          <div className={cn('p-2 rounded-lg shrink-0', chipColor)}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            {breadcrumb && breadcrumb.length > 0 && <Breadcrumb items={breadcrumb} className="mb-1" />}
            {backLink && (
              <a
                href={backLink.href}
                className="text-xs text-ink-muted hover:text-ink transition-colors mb-1 inline-flex items-center gap-1"
              >
                ← {backLink.label}
              </a>
            )}
            <h1 className="text-xl font-semibold text-ink truncate">{title}</h1>
            {subtitle && <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center justify-end gap-2 ml-auto">{actions}</div>}
      </div>
    </div>
  );
}

PageHeader.displayName = 'PageHeader';
