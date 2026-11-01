/**
 * Payroll Employee Create Page — Phase 2.
 * Route: /payroll/employees/new
 */
import { useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { UserPlus, Loader2, ArrowLeft } from 'lucide-react';
import { todayInSast } from '@/lib/saDateParser';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { PersonalSection } from '@/components/payroll/employeeCreate/PersonalSection';
import { EmploymentSection } from '@/components/payroll/employeeCreate/EmploymentSection';
import { TaxAndMedicalSection } from '@/components/payroll/employeeCreate/TaxAndMedicalSection';
import { PaySection } from '@/components/payroll/employeeCreate/PaySection';
import {
  FIELD_ORDER, buildBody, initialForm, validateForm,
  type DateKey, type FieldKey, type FormErrors, type FormState, type RefusedKey,
} from '@/components/payroll/employeeCreate/types';

export default function NewEmployeePage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => initialForm(todayInSast()));
  const [errors, setErrors] = useState<FormErrors>({});
  const [refused, setRefused] = useState<Partial<Record<RefusedKey, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fields = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});
  // State only reaches the disabled button on the next render; a second submit can arrive before that.
  const inFlight = useRef(false);

  const clearError = (k: string) => setErrors(prev => (k in prev ? { ...prev, [k]: undefined } : prev));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm(prev => ({ ...prev, [k]: v }));
    clearError(k);
  };
  const fieldRef = (k: FieldKey) => (el: HTMLElement | null) => { fields.current[k] = el; };
  const checkField = (k: FieldKey) => setErrors(prev => ({ ...prev, [k]: validateForm(form, refused)[k] }));
  // A refused date arrives as null with valid=false; it must block submit, not read as "left empty".
  const setDate = (k: DateKey) => (iso: string | null, validity: FieldValidity) => {
    setRefused(prev => ({ ...prev, [k]: validity.valid ? undefined : (validity.reason ?? 'Enter a valid date.') }));
    set(k, iso ?? '');
  };
  const setSalary = (cents: number | null, validity: FieldValidity) => {
    setRefused(prev => ({ ...prev, salaryCents: validity.valid ? undefined : (validity.reason ?? 'Enter a valid amount.') }));
    set('salaryCents', cents);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current) return;
    setError('');
    const found = validateForm(form, refused);
    setErrors(found);
    const first = FIELD_ORDER.find(k => found[k]);
    if (first) {
      fields.current[first]?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    let target = '';
    try {
      const res = await apiFetch('/api/payroll/employees', {
        method: 'POST',
        body: JSON.stringify(buildBody(form)),
      });
      await assertOk(res, 'Could not create the employee - try again');
      const json = await res.json();
      const created = json.data ?? json;
      target = `/payroll/employees/${created.id}`;
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the employee - try again'));
    } finally {
      if (!target) { inFlight.current = false; setSubmitting(false); }
    }
    if (!target) return;
    // The employee exists; a failed navigation is not a failed save.
    try { await router.push(target); } catch (e) { log.warn('navigation failed', { error: e }, 'NewEmployeePage'); }
    inFlight.current = false;
    setSubmitting(false);
  };

  const section = { form, errors, set, fieldRef, setDate, checkField };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/employees" aria-label="Back to employees" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
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

        <form onSubmit={handleSubmit} noValidate className="p-6 max-w-3xl space-y-2">
          {error && (
            <div role="alert" className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}
          <PersonalSection {...section} />
          <EmploymentSection {...section} />
          <TaxAndMedicalSection {...section} />
          <PaySection {...section} setSalary={setSalary} />
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Employee
            </button>
            <Link href="/payroll/employees" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">Cancel</Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
