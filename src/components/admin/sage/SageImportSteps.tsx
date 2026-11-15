/**
 * Steps 2 and 3 of the admin Sage auto-import (pages/admin/tools/sage-import.tsx):
 * the pulled-data checklist and the Commit panel. Split out of the page to keep it
 * under 300 lines; the page owns the state, the fetches and the commit confirm.
 */

import { Building2, CheckCircle2, Database, FileText, Loader2, ShieldCheck, Users } from 'lucide-react';
import { SageCommitSummary, type SageCommitSummaryData } from '@/components/admin/SageCommitSummary';
import { formatDisplayTimeSeconds } from '@/utils/dateFormat';

export type StepId = 'company' | 'accounts' | 'customers' | 'suppliers' | 'arInvoices' | 'apInvoices';
export type StepStatus = 'pending' | 'done';
export interface PullStep {
  id: StepId;
  label: string;
  icon: typeof Database;
  description: string;
  status: StepStatus;
  count?: number;
}

export const INITIAL_STEPS: PullStep[] = [
  { id: 'company',    label: 'Company Info',           icon: Building2, description: 'Name, tax number, registration',   status: 'pending' },
  { id: 'accounts',   label: 'Chart of Accounts',      icon: Database,  description: 'All GL accounts with categories',  status: 'pending' },
  { id: 'customers',  label: 'Customers',              icon: Users,     description: 'Customer contacts and balances',   status: 'pending' },
  { id: 'suppliers',  label: 'Suppliers',              icon: Building2, description: 'Supplier contacts and balances',   status: 'pending' },
  { id: 'arInvoices', label: 'Customer Invoices (AR)', icon: FileText,  description: 'Outstanding sales invoices',       status: 'pending' },
  { id: 'apInvoices', label: 'Supplier Invoices (AP)', icon: FileText,  description: 'Outstanding purchase invoices',    status: 'pending' },
];

export function SagePulledSteps({ steps, pulling, pulledAt }: { steps: PullStep[]; pulling: boolean; pulledAt: Date | null }) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-gray-900 dark:text-white">Step 2: Pulled Data</h2>
        {pulledAt && (
          <p className="text-xs text-ink-muted">
            Pulled {formatDisplayTimeSeconds(pulledAt)}
          </p>
        )}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {steps.map(step => {
          const Icon = step.icon;
          return (
            <div key={step.id} className="flex items-center gap-3 py-3">
              <div className="p-1.5 rounded bg-gray-100 dark:bg-gray-700">
                <Icon className="h-4 w-4 text-ink-muted" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white">{step.label}</p>
                <p className="text-xs text-ink-muted">{step.description}</p>
              </div>
              <div className="shrink-0">
                {pulling && step.status === 'pending' ? (
                  <Loader2 className="h-4 w-4 animate-spin text-teal-500" />
                ) : step.status === 'done' ? (
                  <span className="flex items-center gap-1 text-xs text-teal-500">
                    <CheckCircle2 className="h-4 w-4" /> {step.count ?? 0}
                  </span>
                ) : (
                  <span className="text-xs text-ink-muted">Waiting</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SageCommitPanel({ summary, committing, onCommit }: {
  summary: SageCommitSummaryData | null;
  committing: boolean;
  onCommit: (mode: 'all' | 'namesAndCoa') => void;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-5 w-5 text-teal-500" />
        <h2 className="font-semibold text-gray-900 dark:text-white">Step 3: Commit to IsaFlow</h2>
      </div>
      {!summary && (
        <p className="text-sm text-ink-muted">
          Existing customers/suppliers are matched by name; duplicate invoice numbers are skipped; existing GL accounts are skipped on conflict (account_code).
        </p>
      )}

      {summary && <SageCommitSummary summary={summary} />}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => onCommit('namesAndCoa')}
          disabled={committing}
          className="inline-flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-900 dark:text-white rounded-lg text-sm font-medium transition-colors"
          title="Commit only Chart of Accounts, Customers and Suppliers — skip AR/AP invoices."
        >
          {committing ? <><Loader2 className="h-4 w-4 animate-spin" /> Committing…</> : 'Commit names + COA only'}
        </button>
        <button
          onClick={() => onCommit('all')}
          disabled={committing}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-teal-800 disabled:text-teal-300 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {committing ? <><Loader2 className="h-4 w-4 animate-spin" /> Committing…</> : summary ? 'Commit again' : 'Commit everything'}
        </button>
      </div>
    </div>
  );
}
