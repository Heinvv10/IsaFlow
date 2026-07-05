/**
 * Payroll Employee Create Page — Phase 2.
 * Route: /payroll/employees/new
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { UserPlus, Loader2, ArrowLeft } from 'lucide-react';

type EmploymentType = 'permanent' | 'contract' | 'casual' | 'director';

interface FormState {
  firstName: string;
  lastName: string;
  employeeNumber: string;
  employmentType: EmploymentType;
  startDate: string;
  idNumber: string;
  taxNumber: string;
  dateOfBirth: string;
  uifExcluded: boolean;
  medicalAidMainMember: boolean;
  medicalAidDependantsCount: string;
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function NewEmployeePage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({
    firstName: '', lastName: '', employeeNumber: '',
    employmentType: 'permanent', startDate: todayISO(),
    idNumber: '', taxNumber: '', dateOfBirth: '',
    uifExcluded: false, medicalAidMainMember: true,
    medicalAidDependantsCount: '0',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    if (!form.firstName || !form.lastName || !form.employeeNumber || !form.startDate) {
      setError('Name, employee number, and start date are required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/payroll/employees', {
        method: 'POST',
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          employeeNumber: form.employeeNumber,
          employmentType: form.employmentType,
          startDate: form.startDate,
          taxNumber: form.taxNumber || undefined,
          idNumber: form.idNumber || undefined,
          dateOfBirth: form.dateOfBirth || undefined,
          uifExcluded: form.uifExcluded,
          medicalAidMainMember: form.medicalAidMainMember,
          medicalAidDependantsCount: Number(form.medicalAidDependantsCount) || 0,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      const created = json.data ?? json;
      void router.push(`/payroll/employees/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  };

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
              <UserPlus className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Employee</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Create a payroll employee</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Identification</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>First name *</label>
                <input className={field} value={form.firstName} onChange={e => set('firstName', e.target.value)} required />
              </div>
              <div>
                <label className={label}>Last name *</label>
                <input className={field} value={form.lastName} onChange={e => set('lastName', e.target.value)} required />
              </div>
              <div>
                <label className={label}>Employee number *</label>
                <input className={field} value={form.employeeNumber} onChange={e => set('employeeNumber', e.target.value)} required />
              </div>
              <div>
                <label className={label}>Employment type</label>
                <select className={field} value={form.employmentType} onChange={e => set('employmentType', e.target.value as EmploymentType)}>
                  <option value="permanent">Permanent</option>
                  <option value="contract">Contract</option>
                  <option value="casual">Casual</option>
                  <option value="director">Director</option>
                </select>
              </div>
              <div>
                <label className={label}>SA ID number</label>
                <input className={field} value={form.idNumber} onChange={e => set('idNumber', e.target.value)} placeholder="13 digits" />
              </div>
              <div>
                <label className={label}>SARS tax number</label>
                <input className={field} value={form.taxNumber} onChange={e => set('taxNumber', e.target.value)} placeholder="10 digits" />
              </div>
              <div>
                <label className={label}>Date of birth</label>
                <input type="date" className={field} value={form.dateOfBirth} onChange={e => set('dateOfBirth', e.target.value)} />
              </div>
              <div>
                <label className={label}>Start date *</label>
                <input type="date" className={field} value={form.startDate} onChange={e => set('startDate', e.target.value)} required />
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Payroll flags</h2>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={form.uifExcluded} onChange={e => set('uifExcluded', e.target.checked)} />
                Excluded from UIF
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={form.medicalAidMainMember} onChange={e => set('medicalAidMainMember', e.target.checked)} />
                Medical aid main member
              </label>
              <div>
                <label className={label}>Medical aid dependants</label>
                <input type="number" min="0" className={field} value={form.medicalAidDependantsCount} onChange={e => set('medicalAidDependantsCount', e.target.value)} />
              </div>
            </div>
          </section>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Employee
            </button>
            <Link href="/payroll/employees" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
