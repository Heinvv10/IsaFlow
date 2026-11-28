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
import { UserPlus, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { todayInSast } from '@/lib/saDateParser';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { PersonalSection } from '@/components/payroll/employeeCreate/PersonalSection';
import { EmploymentSection } from '@/components/payroll/employeeCreate/EmploymentSection';
import { TaxAndMedicalSection } from '@/components/payroll/employeeCreate/TaxAndMedicalSection';
import { PaySection } from '@/components/payroll/employeeCreate/PaySection';
import { BankSection } from '@/components/payroll/employeeCreate/BankSection';
import {
  BANK_FIELD_ORDER, bankIsBlank, emptyBank, saveBankDetails, validateBank,
  type BankErrors, type BankForm, type BankKey,
} from '@/components/payroll/employeeCreate/bankDetails';
import {
  addressIsBlank, emptyAddressForm, saveEmployeeAddress, validateAddressForm,
  type AddressErrors, type AddressFieldKey, type AddressForm,
} from '@/components/payroll/addressForm';
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
  const [bank, setBank] = useState<BankForm>(emptyBank);
  const [bankErrors, setBankErrors] = useState<BankErrors>({});
  const [address, setAddress] = useState<AddressForm>(emptyAddressForm);
  const [addressErrors, setAddressErrors] = useState<AddressErrors>({});
  const addressFields = useRef<Partial<Record<AddressFieldKey, HTMLInputElement | null>>>({});
  /** The employee exists but the address or bank call failed: the form stays, as a notice with the way on, and cannot create twice. */
  const [bankFailure, setBankFailure] = useState<{ id: string; saved: string[]; failed: Array<{ what: string; message: string }> } | null>(null);
  const bankFields = useRef<Partial<Record<BankKey, HTMLElement | null>>>({});
  const fields = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});
  // State only reaches the disabled button on the next render; a second submit can arrive before that.
  const inFlight = useRef(false);

  const clearError = (k: string) => setErrors(prev => (k in prev ? { ...prev, [k]: undefined } : prev));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm(prev => ({ ...prev, [k]: v }));
    clearError(k);
  };
  const setBankField = <K extends keyof BankForm>(k: K, v: BankForm[K]) => {
    setBank(prev => ({ ...prev, [k]: v }));
    setBankErrors(prev => (k in prev ? { ...prev, [k]: undefined } : prev));
  };
  const bankRef = (k: BankKey) => (el: HTMLElement | null) => { bankFields.current[k] = el; };
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
    // Bank details are optional, but a half-filled section is not: stop it before the employee is created.
    const foundBank = bankIsBlank(bank) ? {} : validateBank(bank);
    setBankErrors(foundBank);
    if (first) {
      fields.current[first]?.focus();
      return;
    }
    // The address is optional too, but once typed it must pass the server's own checks (wave 7 EA1).
    const foundAddress = addressIsBlank(address) ? { errors: {}, first: null } : validateAddressForm(address);
    setAddressErrors(foundAddress.errors);
    if (foundAddress.first) {
      addressFields.current[foundAddress.first]?.focus();
      return;
    }
    const firstBank = BANK_FIELD_ORDER.find(k => foundBank[k]);
    if (firstBank) {
      bankFields.current[firstBank]?.focus();
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
      // Each follow-up is tried whatever the other did (review #1932 M): a failed address must not drop typed bank details.
      const saved: string[] = [];
      const failed: Array<{ what: string; message: string }> = [];
      const followUp = async (what: string, run: () => Promise<void>, fallback: string) => {
        try { await run(); saved.push(what); } catch (err) { failed.push({ what, message: apiErrorMessage(err, fallback) }); }
      };
      if (!addressIsBlank(address)) await followUp('address', () => saveEmployeeAddress(created.id, address), 'Could not save the address');
      if (!bankIsBlank(bank)) await followUp('bank details', () => saveBankDetails(created.id, bank), 'Could not save the bank details');
      if (failed.length > 0) {
        setBankFailure({ id: created.id, saved, failed });
        setSubmitting(false); // inFlight stays set: the employee exists, and this form does not create a second
        return;
      }
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
        <PageHeader icon={UserPlus} title="New Employee" subtitle="Create a payroll employee"
          backLink={{ label: 'Employees', href: '/payroll/employees' }} className="mb-0" />

        <form onSubmit={handleSubmit} noValidate className="p-6 max-w-3xl space-y-2">
          {bankFailure && (
            <div role="alert" className="px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-300 text-sm">
              Employee saved{bankFailure.saved.length > 0 ? `, with its ${bankFailure.saved.join(' and ')}` : ''};{' '}
              {bankFailure.failed.map((f) => `${f.what} not saved: ${f.message.replace(/[.\s]+$/, '')}`).join('; ')}.
              {' '}Add {bankFailure.failed.length === 1 && bankFailure.failed[0]!.what === 'address' ? 'it' : 'them'} on the profile.
            </div>
          )}
          {error && (
            <div role="alert" className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}
          {/* The employee exists once the bank call has failed: a field edited now would be discarded, so the form is read-only. */}
          <fieldset disabled={bankFailure !== null} className="contents">
            <PersonalSection {...section} address={{
              form: address, errors: addressErrors, fieldRef: (k) => (el) => { addressFields.current[k] = el; },
              onChange: (k, path, v) => { setAddress(prev => ({ ...prev, [k]: v })); setAddressErrors(prev => (prev[path] ? { ...prev, [path]: [] } : prev)); },
              onSameChange: (same) => setAddress(prev => ({ ...prev, sameAsResidential: same })),
            }} />
            <EmploymentSection {...section} />
            <TaxAndMedicalSection {...section} />
            <PaySection {...section} setSalary={setSalary} />
            <BankSection bank={bank} errors={bankErrors} onChange={setBankField} fieldRef={bankRef} />
          </fieldset>
          <div className="flex items-center gap-3 pt-2">
            {bankFailure ? (
              <Link href={`/payroll/employees/${bankFailure.id}`} className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium">
                Open the profile
              </Link>
            ) : (<>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Employee
            </button>
            <Link href="/payroll/employees" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">Cancel</Link>
            </>)}
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
