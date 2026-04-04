import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  CheckCircle2, AlertCircle, Loader2, Circle,
  BookOpen, Users, Truck, Scale, FileText, ClipboardList, ShieldCheck,
  Building2,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useAuth } from '@/contexts/AuthContext';
import { log } from '@/lib/logger';

interface StepsCompleted {
  coa?: boolean;
  customers?: boolean;
  suppliers?: boolean;
  opening_balances?: boolean;
  ar_invoices?: boolean;
  ap_invoices?: boolean;
  validated?: boolean;
}

interface MigrationSession {
  id: string;
  sourceSystem: string | null;
  status: string;
  stepsCompleted: StepsCompleted;
  coaRecordsImported: number;
  customersImported: number;
  suppliersImported: number;
  openingBalancesSet: boolean;
  arInvoicesImported: number;
  apInvoicesImported: number;
  startedAt: string;
}

const SOURCE_SYSTEMS = [
  { id: 'sage_cloud', label: 'Sage Business Cloud', icon: '☁️', desc: '3-digit account codes' },
  { id: 'sage_50', label: 'Sage 50 / Pastel', icon: '📊', desc: '7-digit account codes' },
  { id: 'xero', label: 'Xero', icon: '✕', desc: 'Flexible code format' },
  { id: 'quickbooks', label: 'QuickBooks Online', icon: '🔵', desc: 'Account type driven' },
  { id: 'wave', label: 'Wave / FreshBooks', icon: '🌊', desc: 'Simple CSV export' },
  { id: 'other', label: 'Other / Manual CSV', icon: '📁', desc: 'Generic CSV format' },
];

interface WizardStep {
  id: keyof StepsCompleted;
  label: string;
  href: string;
  icon: React.ReactNode;
  desc: string;
}

const STEPS: WizardStep[] = [
  { id: 'coa', label: 'Chart of Accounts', href: '/accounting/migration/chart-of-accounts', icon: <BookOpen className="h-5 w-5" />, desc: 'Import your accounts structure' },
  { id: 'customers', label: 'Customers', href: '/accounting/migration/customers', icon: <Users className="h-5 w-5" />, desc: 'Import customer records' },
  { id: 'suppliers', label: 'Suppliers', href: '/accounting/migration/suppliers', icon: <Truck className="h-5 w-5" />, desc: 'Import supplier records' },
  { id: 'opening_balances', label: 'Opening Balances', href: '/accounting/migration/opening-balances', icon: <Scale className="h-5 w-5" />, desc: 'Set trial balance' },
  { id: 'ar_invoices', label: 'Outstanding AR Invoices', href: '/accounting/migration/ar-invoices', icon: <FileText className="h-5 w-5" />, desc: 'Unpaid customer invoices' },
  { id: 'ap_invoices', label: 'Outstanding AP Invoices', href: '/accounting/migration/ap-invoices', icon: <ClipboardList className="h-5 w-5" />, desc: 'Unpaid supplier invoices' },
  { id: 'validated', label: 'Validation & Go-Live', href: '/accounting/migration/validate', icon: <ShieldCheck className="h-5 w-5" />, desc: 'Verify and complete migration' },
];

export default function MigrationHubPage() {
  const { user } = useAuth();
  const [session, setSession] = useState<MigrationSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selecting, setSelecting] = useState(false);

  const loadSession = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/migration/session');
      const json = await res.json();
      if (res.ok && json.data) {
        setSession(json.data.session ?? json.data);
      }
    } catch (e) {
      log.warn('Failed to load migration session', { error: e }, 'migration');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadSession(); }, [loadSession]);

  const selectSource = async (sourceSystem: string) => {
    setSelecting(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/migration/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceSystem }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to create session');
      setSession(json.data.session ?? json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start migration');
    } finally {
      setSelecting(false);
    }
  };

  const stepStatus = (id: keyof StepsCompleted): 'completed' | 'not_started' => {
    if (!session) return 'not_started';
    return session.stepsCompleted[id] ? 'completed' : 'not_started';
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Building2 className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Migration Wizard</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Migrate your data from any accounting system to ISAFlow</p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            </div>
          ) : !session ? (
            <SourceSelection onSelect={selectSource} selecting={selecting} isSuperAdmin={user?.role === 'super_admin'} />
          ) : (
            <div className="space-y-6">
              <SessionSummary session={session} onReset={() => setSession(null)} />
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                <div className="px-5 py-4 border-b border-[var(--ff-border-light)]">
                  <h2 className="font-semibold text-[var(--ff-text-primary)]">Migration Steps</h2>
                  <p className="text-xs text-[var(--ff-text-secondary)] mt-0.5">Complete each step in order for best results</p>
                </div>
                <div className="divide-y divide-[var(--ff-border-light)]">
                  {STEPS.map((step, i) => {
                    const status = stepStatus(step.id);
                    return (
                      <Link
                        key={step.id}
                        href={step.href}
                        className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--ff-bg-primary)] transition-colors"
                      >
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-[var(--ff-bg-primary)] text-[var(--ff-text-tertiary)] text-sm font-bold shrink-0">
                          {status === 'completed'
                            ? <CheckCircle2 className="h-5 w-5 text-teal-400" />
                            : <span className="text-xs">{i + 1}</span>
                          }
                        </div>
                        <div className="text-[var(--ff-text-secondary)] shrink-0">{step.icon}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--ff-text-primary)]">{step.label}</p>
                          <p className="text-xs text-[var(--ff-text-secondary)]">{step.desc}</p>
                        </div>
                        <StepBadge status={status} />
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function SourceSelection({ onSelect, selecting, isSuperAdmin }: { onSelect: (s: string) => void; selecting: boolean; isSuperAdmin?: boolean }) {
  return (
    <div className="space-y-4">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Step 1: Choose Your Source System</h2>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-5">Select the accounting software you are migrating from.</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {SOURCE_SYSTEMS.map(sys => (
            <button
              key={sys.id}
              onClick={() => onSelect(sys.id)}
              disabled={selecting}
              className="flex flex-col gap-1 p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-blue-500 hover:bg-blue-500/5 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-2xl">{sys.icon}</span>
              <span className="text-sm font-medium text-[var(--ff-text-primary)]">{sys.label}</span>
              <span className="text-xs text-[var(--ff-text-secondary)]">{sys.desc}</span>
            </button>
          ))}
        </div>
      </div>
      {isSuperAdmin && (
        <div className="bg-green-500/5 rounded-lg border border-green-500/20 p-5">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-lg">⚡</span>
            <h3 className="font-semibold text-[var(--ff-text-primary)]">Auto-Import from Sage</h3>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-400">Admin</span>
          </div>
          <p className="text-sm text-[var(--ff-text-secondary)] mb-3">
            Already on Sage Business Cloud? Skip the CSV files — pull your data directly from your Sage account.
          </p>
          <Link
            href="/accounting/migration/sage-auto"
            className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-500 text-sm font-medium"
          >
            Auto-Import from Sage →
          </Link>
        </div>
      )}
    </div>
  );
}

function SessionSummary({ session, onReset }: { session: MigrationSession; onReset: () => void }) {
  const sourceLabel = SOURCE_SYSTEMS.find(s => s.id === session.sourceSystem)?.label ?? session.sourceSystem ?? 'Unknown';
  const completed = Object.values(session.stepsCompleted).filter(Boolean).length;
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide mb-1">Active Migration</p>
          <p className="font-semibold text-[var(--ff-text-primary)]">From: {sourceLabel}</p>
          <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
            {completed}/{STEPS.length} steps completed &bull; Started {new Date(session.startedAt).toLocaleDateString('en-ZA')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={session.status} />
          {session.status !== 'completed' && (
            <button
              onClick={onReset}
              className="text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] underline"
            >
              Start over
            </button>
          )}
        </div>
      </div>
      <div className="mt-4 h-2 rounded-full bg-[var(--ff-bg-primary)] overflow-hidden">
        <div
          className="h-full rounded-full bg-blue-500 transition-all"
          style={{ width: `${(completed / STEPS.length) * 100}%` }}
        />
      </div>
    </div>
  );
}

function StepBadge({ status }: { status: 'completed' | 'not_started' }) {
  if (status === 'completed') {
    return <span className="px-2 py-0.5 rounded text-xs font-medium bg-teal-500/20 text-teal-400">Completed</span>;
  }
  return <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-500/20 text-gray-400">Not started</span>;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    in_progress: 'bg-blue-500/20 text-blue-400',
    completed: 'bg-teal-500/20 text-teal-400',
    abandoned: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-gray-500/20 text-gray-400'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
