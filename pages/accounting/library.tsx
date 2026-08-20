/**
 * Library — the demoted-module directory. A calm grid of the 8 modules that
 * used to be top-level tabs. Pure presentational: no API, no company scoping.
 */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { libraryModulesFor } from '@/components/accounting/navSections/library';
import { useVatRegistration } from '@/hooks/useVatRegistration';

export default function LibraryPage() {
  const { isRegistered } = useVatRegistration();
  const modules = libraryModulesFor(isRegistered);
  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Library</h1>
          <p className="text-sm text-[var(--ff-text-secondary)]">
            Full-ledger modules. Your day-to-day work lives on the Dashboard, Portfolio, Month-End and Banking.
          </p>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {modules.map((m) => (
            <Link
              key={m.id}
              href={m.href}
              style={{ borderRadius: 'var(--ff-card-radius)' }}
              className="group flex items-start gap-3 p-4 border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] hover:bg-[var(--ff-bg-tertiary)] hover:border-teal-400 transition-colors"
            >
              <span className="mt-0.5 text-teal-500" aria-hidden="true">{m.icon}</span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center justify-between">
                  <span className="font-medium text-[var(--ff-text-primary)]">{m.label}</span>
                  <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors" />
                </span>
                <span className="block text-sm text-[var(--ff-text-secondary)] mt-0.5">{m.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
