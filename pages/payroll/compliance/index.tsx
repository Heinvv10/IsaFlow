/**
 * Payroll Compliance Hub — links to IRP5 and EMP501 filing.
 * Route: /payroll/compliance
 */
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Scale, ArrowRight } from 'lucide-react';

const CARDS = [
  {
    href: '/payroll/irp5',
    icon: FileText,
    title: 'IRP5 Certificates',
    description: 'Review employee IRP5 readiness. Check for missing tax numbers, ID numbers, and verify annual earnings before filing with SARS.',
    color: 'teal',
  },
  {
    href: '/payroll/emp501',
    icon: Scale,
    title: 'EMP501 Reconciliation',
    description: 'Reconcile monthly EMP201 PAYE declarations against IRP5 totals. Identify and resolve variances before submitting the annual EMP501 return.',
    color: 'blue',
  },
];

export default function PayrollCompliancePage() {
  return (
    <AppLayout>
      <div className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-1">Payroll Compliance</h1>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-8">
          Annual SARS filing — generate IRP5 certificates and reconcile EMP501 returns.
        </p>

        <div className="grid gap-4">
          {CARDS.map(({ href, icon: Icon, title, description, color }) => (
            <Link
              key={href}
              href={href}
              className="group flex items-start gap-5 p-5 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] hover:border-teal-500/40 hover:bg-[var(--ff-bg-tertiary)] transition-colors"
            >
              <div className={`p-3 rounded-lg bg-${color}-500/10 text-${color}-400 shrink-0`}>
                <Icon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">{title}</h2>
                  <ArrowRight className="w-4 h-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-400 transition-colors shrink-0" />
                </div>
                <p className="mt-1 text-sm text-[var(--ff-text-secondary)] leading-relaxed">{description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
