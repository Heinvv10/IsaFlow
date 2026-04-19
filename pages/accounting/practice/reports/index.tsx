/**
 * Practice Reports Hub
 * Route: /accounting/practice/reports
 */
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, TrendingUp, Clock, BarChart3, ShieldCheck, PieChart, ArrowRight } from 'lucide-react';

const REPORTS = [
  {
    href: '/accounting/practice/reports/utilisation',
    icon: Users,
    title: 'Staff Utilisation',
    description: 'Billable vs non-billable hours per staff member. Track productivity and identify capacity.',
  },
  {
    href: '/accounting/practice/reports/profitability',
    icon: TrendingUp,
    title: 'Client Profitability',
    description: 'Revenue vs cost per client. Compare billing rates against cost rates to see margin by engagement.',
  },
  {
    href: '/accounting/practice/reports/wip-aging',
    icon: Clock,
    title: 'WIP Aging',
    description: 'Unbilled work-in-progress aged by weeks. Identify stale WIP that needs to be billed or written off.',
  },
  {
    href: '/accounting/practice/reports/revenue-pipeline',
    icon: BarChart3,
    title: 'Revenue Pipeline',
    description: 'Forecast revenue from active jobs and quoted work. View by month and by client.',
  },
  {
    href: '/accounting/practice/reports/compliance',
    icon: ShieldCheck,
    title: 'Compliance Report',
    description: 'Deadline tracking across all client engagements. Flag overdue and at-risk filings.',
  },
  {
    href: '/accounting/practice/reports/service-mix',
    icon: PieChart,
    title: 'Service Mix',
    description: 'Revenue breakdown by service type. Understand which engagements drive the most income.',
  },
];

export default function PracticeReportsIndexPage() {
  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-1">Practice Reports</h1>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-8">
          Management reporting across utilisation, profitability, WIP, and compliance.
        </p>

        <div className="grid gap-3">
          {REPORTS.map(({ href, icon: Icon, title, description }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-start gap-4 p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] hover:border-teal-500/40 hover:bg-[var(--ff-bg-tertiary)] transition-colors"
            >
              <div className="p-2.5 rounded-lg bg-teal-500/10 text-teal-400 shrink-0">
                <Icon className="w-4 h-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title}</h2>
                  <ArrowRight className="w-4 h-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-400 transition-colors shrink-0" />
                </div>
                <p className="mt-0.5 text-xs text-[var(--ff-text-secondary)] leading-relaxed">{description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
