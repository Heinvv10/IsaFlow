/**
 * Employee Duplicates — flags potential data-entry/fraud issues.
 * Route: /payroll/duplicates
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertTriangle, Loader2, AlertCircle, UserCheck } from 'lucide-react';

interface DupEmployee {
  id: string;
  employeeNumber: string;
  name: string;
  status: string;
}
interface DupGroup {
  value: string;
  employees: DupEmployee[];
}
interface DupResult {
  idNumber: DupGroup[];
  taxNumber: DupGroup[];
  passportNumber: DupGroup[];
  employeeNumber: DupGroup[];
  bankAccount: DupGroup[];
  totals: { totalConflicts: number; affectedEmployees: number };
}

const TABS: Array<{ key: keyof Omit<DupResult, 'totals'>; label: string }> = [
  { key: 'idNumber', label: 'ID Number' },
  { key: 'taxNumber', label: 'Tax Number' },
  { key: 'passportNumber', label: 'Passport' },
  { key: 'bankAccount', label: 'Bank Account' },
  { key: 'employeeNumber', label: 'Employee #' },
];

export default function DuplicatesPage() {
  const [data, setData] = useState<DupResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<keyof Omit<DupResult, 'totals'>>('idNumber');
  const [includeTerminated, setIncludeTerminated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = includeTerminated ? '?includeTerminated=1' : '';
      const res = await apiFetch(`/api/payroll/duplicates${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData((json.data ?? json) as DupResult);
    } catch {
      setError('Failed to load duplicates');
    } finally {
      setLoading(false);
    }
  }, [includeTerminated]);

  useEffect(() => { load(); }, [load]);

  const groups = data ? data[activeTab] : [];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Employee Duplicates</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Potential data-entry errors or duplicate records</p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
            <input type="checkbox" checked={includeTerminated} onChange={e => setIncludeTerminated(e.target.checked)} />
            Include terminated
          </label>
        </div>

        <div className="p-6 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : data && data.totals.totalConflicts === 0 ? (
            <div className="text-center py-16">
              <UserCheck className="h-12 w-12 text-emerald-500 mx-auto mb-3" />
              <p className="text-[var(--ff-text-primary)] font-medium">No duplicates found</p>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-1">Employee master data is clean.</p>
            </div>
          ) : data ? (
            <>
              <div className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
                <span>{data.totals.totalConflicts} conflict group(s)</span>
                <span>·</span>
                <span>{data.totals.affectedEmployees} employee(s) affected</span>
              </div>

              <div className="flex gap-2 border-b border-[var(--ff-border-primary)]">
                {TABS.map(t => {
                  const count = data[t.key].length;
                  return (
                    <button key={t.key} onClick={() => setActiveTab(t.key)}
                      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === t.key ? 'border-amber-500 text-[var(--ff-text-primary)]' : 'border-transparent text-[var(--ff-text-secondary)]'}`}>
                      {t.label}
                      {count > 0 && <span className="ml-2 px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 text-xs">{count}</span>}
                    </button>
                  );
                })}
              </div>

              {groups.length === 0 ? (
                <div className="text-sm text-[var(--ff-text-secondary)] py-6 text-center">No conflicts on this field.</div>
              ) : (
                <div className="space-y-3">
                  {groups.map(g => (
                    <div key={g.value} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
                      <div className="text-sm text-[var(--ff-text-secondary)] mb-3">
                        Shared value: <span className="font-mono text-[var(--ff-text-primary)]">{g.value}</span>
                      </div>
                      <div className="space-y-1">
                        {g.employees.map(e => (
                          <Link key={e.id} href={`/payroll/employees/${e.id}`}
                            className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-[var(--ff-bg-tertiary)]">
                            <div className="text-sm text-[var(--ff-text-primary)]">
                              <span className="font-mono text-[var(--ff-text-secondary)] mr-3">{e.employeeNumber}</span>
                              {e.name}
                            </div>
                            <span className="text-xs text-[var(--ff-text-secondary)]">{e.status}</span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
