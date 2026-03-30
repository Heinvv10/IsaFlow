/**
 * External Migration Wizard — Xero, QuickBooks, Pastel CSV import
 * Step 1: Source selection
 * Steps 2-5: handled by ExternalMigrationWizard component
 */

import { useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Database } from 'lucide-react';
import { ExternalMigrationWizard } from '@/components/accounting/migration/ExternalMigrationWizard';
import type { MigrationSource } from '@/modules/accounting/services/migrationParserService';

interface SourceCard {
  id: MigrationSource;
  label: string;
  description: string;
  formats: string;
  color: string;
}

const SOURCES: SourceCard[] = [
  {
    id: 'xero',
    label: 'Xero',
    description: 'Import your Chart of Accounts, customers, and suppliers from Xero CSV exports.',
    formats: 'CSV — Account Code, Account Name, Type, YTD Balance',
    color: 'blue',
  },
  {
    id: 'quickbooks',
    label: 'QuickBooks Online',
    description: 'Import from QuickBooks Online account type-based CSV exports.',
    formats: 'CSV — Account, Type, Balance, Detail Type',
    color: 'green',
  },
  {
    id: 'pastel',
    label: 'Pastel / Sage 50',
    description: 'Import from Pastel Partner or Sage 50 numeric account code exports.',
    formats: 'CSV — AccNumber, Description, AccType, CurrentBalance',
    color: 'orange',
  },
];

const COLOR_MAP: Record<string, string> = {
  blue:   'border-blue-500/30 hover:border-blue-500 hover:bg-blue-500/5',
  green:  'border-green-500/30 hover:border-green-500 hover:bg-green-500/5',
  orange: 'border-orange-500/30 hover:border-orange-500 hover:bg-orange-500/5',
};

const BADGE_MAP: Record<string, string> = {
  blue:   'bg-blue-500/10 text-blue-400',
  green:  'bg-green-500/10 text-green-400',
  orange: 'bg-orange-500/10 text-orange-400',
};

export default function ExternalMigrationPage() {
  const [selectedSource, setSelectedSource] = useState<MigrationSource | null>(null);
  const [done, setDone] = useState(false);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting/migration" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Migration Wizard
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Database className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Import from External System</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Migrate Xero, QuickBooks, or Pastel data into ISAFlow via CSV</p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {done ? (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-8 text-center space-y-4">
              <p className="text-lg font-semibold text-teal-400">Migration complete!</p>
              <p className="text-sm text-[var(--ff-text-secondary)]">Your data has been imported into ISAFlow.</p>
              <div className="flex items-center justify-center gap-3">
                <Link
                  href="/accounting/chart-of-accounts"
                  className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
                >
                  View Chart of Accounts
                </Link>
                <button
                  onClick={() => { setDone(false); setSelectedSource(null); }}
                  className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
                >
                  Import another
                </button>
              </div>
            </div>
          ) : !selectedSource ? (
            <SourceSelection onSelect={setSelectedSource} />
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="font-semibold text-[var(--ff-text-primary)]">
                  Importing from {SOURCES.find(s => s.id === selectedSource)?.label}
                </h2>
                <button
                  onClick={() => setSelectedSource(null)}
                  className="text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] underline"
                >
                  Change source
                </button>
              </div>
              <ExternalMigrationWizard
                source={selectedSource}
                onDone={() => setDone(true)}
                onBack={() => setSelectedSource(null)}
              />
            </div>
          )}

          {/* Link to Sage-specific tools */}
          <div className="p-4 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)]">
            Looking for the Sage Business Cloud migration? Use the{' '}
            <Link href="/accounting/sage-migration" className="text-orange-400 hover:underline">
              Sage Migration tool
            </Link>
            {' '}or{' '}
            <Link href="/accounting/migration" className="text-blue-400 hover:underline">
              Full Migration Wizard
            </Link>
            {' '}for a guided step-by-step process.
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function SourceSelection({ onSelect }: { onSelect: (s: MigrationSource) => void }) {
  return (
    <div className="space-y-4">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Choose Your Source System</h2>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-5">
          Select the system you are migrating from. You will upload CSV exports from that system.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          {SOURCES.map(src => (
            <button
              key={src.id}
              onClick={() => onSelect(src.id)}
              className={`text-left p-5 rounded-lg border bg-[var(--ff-bg-primary)] transition-all ${COLOR_MAP[src.color]}`}
            >
              <div className={`inline-flex px-2 py-0.5 rounded text-xs font-semibold mb-3 ${BADGE_MAP[src.color]}`}>
                {src.label}
              </div>
              <p className="text-sm text-[var(--ff-text-primary)] mb-2">{src.description}</p>
              <p className="text-xs text-[var(--ff-text-tertiary)]">{src.formats}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 rounded-lg bg-blue-500/5 border border-blue-500/20 text-xs text-[var(--ff-text-secondary)] space-y-1">
        <p className="font-semibold text-[var(--ff-text-primary)]">What gets imported?</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Chart of Accounts — mapped to ISAFlow GL account types</li>
          <li>Opening balances — posted as a journal entry</li>
          <li>Customers and suppliers — contact records</li>
        </ul>
      </div>
    </div>
  );
}
