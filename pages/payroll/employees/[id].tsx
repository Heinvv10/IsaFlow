/**
 * Payroll Employee Detail + Edit + Components — Phase 2.
 * Route: /payroll/employees/[id]
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { User, ArrowLeft, Loader2, AlertCircle, Plus, X, Save } from 'lucide-react';

interface Employee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  employmentType: 'permanent' | 'contract' | 'casual' | 'director';
  startDate: string;
  endDate?: string;
  taxNumber?: string;
  idNumber?: string;
  dateOfBirth?: string;
  uifExcluded: boolean;
  medicalAidMainMember: boolean;
  medicalAidDependantsCount: number;
}

interface Component {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
}

interface Assignment {
  id: string;
  componentId: string;
  componentName: string;
  componentType: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export default function EmployeeDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const employeeId = typeof id === 'string' ? id : '';

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [components, setComponents] = useState<Component[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  const [newComponentId, setNewComponentId] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newFrom, setNewFrom] = useState(new Date().toISOString().slice(0, 10));
  const [addingAssignment, setAddingAssignment] = useState(false);

  const loadAll = useCallback(async () => {
    if (!employeeId) return;
    setIsLoading(true);
    setError('');
    try {
      const [eRes, cRes, aRes] = await Promise.all([
        apiFetch(`/api/payroll/employees/${employeeId}`),
        apiFetch('/api/payroll/components'),
        apiFetch(`/api/payroll/employees/${employeeId}/components`),
      ]);
      if (!eRes.ok) throw new Error(`Employee HTTP ${eRes.status}`);
      const eJson = await eRes.json();
      const cJson = cRes.ok ? await cRes.json() : { data: [] };
      const aJson = aRes.ok ? await aRes.json() : { data: [] };
      setEmployee((eJson.data ?? eJson) as Employee);
      setComponents((cJson.data ?? cJson) as Component[]);
      setAssignments((aJson.data ?? aJson) as Assignment[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setIsLoading(false);
    }
  }, [employeeId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const saveProfile = async () => {
    if (!employee) return;
    setSavingProfile(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/employees/${employee.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: employee.firstName,
          lastName: employee.lastName,
          employmentType: employee.employmentType,
          taxNumber: employee.taxNumber,
          idNumber: employee.idNumber,
          dateOfBirth: employee.dateOfBirth,
          endDate: employee.endDate,
          uifExcluded: employee.uifExcluded,
          medicalAidMainMember: employee.medicalAidMainMember,
          medicalAidDependantsCount: employee.medicalAidDependantsCount,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingProfile(false);
    }
  };

  const assignComponent = async () => {
    if (!newComponentId || !newAmount) return;
    setAddingAssignment(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/components`, {
        method: 'POST',
        body: JSON.stringify({
          componentId: newComponentId,
          amount: Number(newAmount),
          effectiveFrom: newFrom,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
      }
      setNewComponentId(''); setNewAmount('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed');
    } finally {
      setAddingAssignment(false);
    }
  };

  const endAssignment = async (assignmentId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await apiFetch(
      `/api/payroll/employees/${employeeId}/components?aid=${assignmentId}`,
      { method: 'DELETE', body: JSON.stringify({ effectiveTo: today }) },
    );
    if (res.ok) await loadAll();
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)]">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error && !employee) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)] flex-col gap-2">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-red-400 text-sm">{error}</p>
          <Link href="/payroll/employees" className="text-teal-400 text-sm">Back</Link>
        </div>
      </AppLayout>
    );
  }

  if (!employee) return null;

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
  const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/employees" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <User className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
                {employee.firstName} {employee.lastName}
              </h1>
              <p className="text-sm text-[var(--ff-text-secondary)] font-mono">{employee.employeeNumber}</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Profile</h2>
              <button
                onClick={saveProfile}
                disabled={savingProfile}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-medium"
              >
                {savingProfile ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>First name</label>
                <input className={field} value={employee.firstName}
                  onChange={e => setEmployee({ ...employee, firstName: e.target.value })} />
              </div>
              <div>
                <label className={label}>Last name</label>
                <input className={field} value={employee.lastName}
                  onChange={e => setEmployee({ ...employee, lastName: e.target.value })} />
              </div>
              <div>
                <label className={label}>Tax number</label>
                <input className={field} value={employee.taxNumber ?? ''}
                  onChange={e => setEmployee({ ...employee, taxNumber: e.target.value })} />
              </div>
              <div>
                <label className={label}>ID number</label>
                <input className={field} value={employee.idNumber ?? ''}
                  onChange={e => setEmployee({ ...employee, idNumber: e.target.value })} />
              </div>
              <div>
                <label className={label}>Date of birth</label>
                <input type="date" className={field} value={employee.dateOfBirth?.slice(0, 10) ?? ''}
                  onChange={e => setEmployee({ ...employee, dateOfBirth: e.target.value })} />
              </div>
              <div>
                <label className={label}>End date</label>
                <input type="date" className={field} value={employee.endDate?.slice(0, 10) ?? ''}
                  onChange={e => setEmployee({ ...employee, endDate: e.target.value || undefined })} />
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={employee.uifExcluded}
                  onChange={e => setEmployee({ ...employee, uifExcluded: e.target.checked })} />
                UIF excluded
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={employee.medicalAidMainMember}
                  onChange={e => setEmployee({ ...employee, medicalAidMainMember: e.target.checked })} />
                Medical aid main member
              </label>
              <div>
                <label className={label}>Medical aid dependants</label>
                <input type="number" min="0" className={field} value={employee.medicalAidDependantsCount}
                  onChange={e => setEmployee({ ...employee, medicalAidDependantsCount: Number(e.target.value) || 0 })} />
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Pay Components</h2>

            <div className="flex items-end gap-3 mb-4 pb-4 border-b border-[var(--ff-border-primary)]">
              <div className="flex-1">
                <label className={label}>Component</label>
                <select className={field} value={newComponentId} onChange={e => setNewComponentId(e.target.value)}>
                  <option value="">Select a component…</option>
                  {components.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.componentType})</option>
                  ))}
                </select>
              </div>
              <div className="w-40">
                <label className={label}>Amount (R)</label>
                <input type="number" step="0.01" className={field}
                  value={newAmount} onChange={e => setNewAmount(e.target.value)} />
              </div>
              <div className="w-40">
                <label className={label}>Effective from</label>
                <input type="date" className={field}
                  value={newFrom} onChange={e => setNewFrom(e.target.value)} />
              </div>
              <button
                onClick={assignComponent}
                disabled={!newComponentId || !newAmount || addingAssignment}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
              >
                {addingAssignment ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Assign
              </button>
            </div>

            {assignments.length === 0 ? (
              <p className="text-sm text-[var(--ff-text-tertiary)]">No components assigned yet. Assign at least a basic-salary component to produce non-zero payroll.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] text-left">
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">Component</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium text-right">Amount</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">From</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">To</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map(a => (
                    <tr key={a.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-2 text-[var(--ff-text-primary)]">{a.componentName}</td>
                      <td className="py-2 text-[var(--ff-text-secondary)] capitalize">{a.componentType}</td>
                      <td className="py-2 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(a.amount)}</td>
                      <td className="py-2 text-[var(--ff-text-secondary)]">{a.effectiveFrom.slice(0, 10)}</td>
                      <td className="py-2 text-[var(--ff-text-secondary)]">{a.effectiveTo ? a.effectiveTo.slice(0, 10) : '—'}</td>
                      <td className="py-2 text-right">
                        {!a.effectiveTo && (
                          <button onClick={() => endAssignment(a.id)}
                            className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] hover:text-red-400">
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </AppLayout>
  );
}
