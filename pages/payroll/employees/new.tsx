/**
 * New Employee Form Page
 * Creates a new employee with personal, employment, banking, and pay details.
 * Route: /payroll/employees/new
 */

import { useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, Loader2, ArrowLeft, Save } from 'lucide-react';
import Link from 'next/link';
import { notify } from '@/utils/toast';

interface EmployeeFormData {
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string;
  tax_number: string;
  start_date: string;
  department: string;
  position: string;
  employment_type: string;
  pay_frequency: string;
  bank_name: string;
  bank_account_number: string;
  bank_branch_code: string;
  basic_salary: string;
  travel_allowance: string;
  housing_allowance: string;
  cell_allowance: string;
  other_allowances: string;
  medical_aid_contribution: string;
  retirement_fund_contribution_pct: string;
}

const INITIAL_FORM: EmployeeFormData = {
  employee_number: '',
  first_name: '',
  last_name: '',
  id_number: '',
  tax_number: '',
  start_date: new Date().toISOString().split('T')[0] || '',
  department: '',
  position: '',
  employment_type: 'permanent',
  pay_frequency: 'monthly',
  bank_name: '',
  bank_account_number: '',
  bank_branch_code: '',
  basic_salary: '',
  travel_allowance: '0',
  housing_allowance: '0',
  cell_allowance: '0',
  other_allowances: '0',
  medical_aid_contribution: '0',
  retirement_fund_contribution_pct: '0',
};

const SA_BANKS = [
  'ABSA Bank',
  'Capitec Bank',
  'First National Bank (FNB)',
  'Investec',
  'Nedbank',
  'Standard Bank',
  'TymeBank',
  'African Bank',
  'Discovery Bank',
  'Other',
];

export default function NewEmployeePage() {
  const router = useRouter();
  const [form, setForm] = useState<EmployeeFormData>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof EmployeeFormData, string>>>({});

  function updateField(field: keyof EmployeeFormData, value: string) {
    setForm(prev => ({ ...prev, [field]: value }));
    if (fieldErrors[field]) {
      setFieldErrors(prev => ({ ...prev, [field]: undefined }));
    }
  }

  function validate(): boolean {
    const errors: Partial<Record<keyof EmployeeFormData, string>> = {};
    if (!form.employee_number.trim()) errors.employee_number = 'Employee number is required';
    if (!form.first_name.trim()) errors.first_name = 'First name is required';
    if (!form.last_name.trim()) errors.last_name = 'Last name is required';
    if (!form.start_date) errors.start_date = 'Start date is required';
    if (!form.basic_salary || isNaN(Number(form.basic_salary)) || Number(form.basic_salary) <= 0) {
      errors.basic_salary = 'Valid basic salary is required';
    }
    if (form.id_number && form.id_number.length !== 13) {
      errors.id_number = 'SA ID number must be 13 digits';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/payroll/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          basic_salary: Number(form.basic_salary),
          travel_allowance: Number(form.travel_allowance || 0),
          housing_allowance: Number(form.housing_allowance || 0),
          cell_allowance: Number(form.cell_allowance || 0),
          other_allowances: Number(form.other_allowances || 0),
          medical_aid_contribution: Number(form.medical_aid_contribution || 0),
          retirement_fund_contribution_pct: Number(form.retirement_fund_contribution_pct || 0),
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? json.message ?? `HTTP ${res.status}`);

      notify.success('Employee created successfully');
      await router.push('/payroll/employees');
    } catch (err: unknown) {
      notify.error(err instanceof Error ? err.message : 'Failed to create employee');
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputClass = (field: keyof EmployeeFormData) =>
    `w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border ${
      fieldErrors[field] ? 'border-red-500' : 'border-[var(--ff-border-primary)]'
    } text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500`;

  const labelClass = 'block text-sm font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href="/payroll/employees"
                className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Employee</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Add a new payroll employee</p>
              </div>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-4xl">
          {/* Personal Details */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Personal Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Employee Number *</label>
                <input type="text" value={form.employee_number} onChange={(e) => updateField('employee_number', e.target.value)} className={inputClass('employee_number')} placeholder="EMP001" />
                {fieldErrors.employee_number && <p className="text-xs text-red-400 mt-1">{fieldErrors.employee_number}</p>}
              </div>
              <div />
              <div>
                <label className={labelClass}>First Name *</label>
                <input type="text" value={form.first_name} onChange={(e) => updateField('first_name', e.target.value)} className={inputClass('first_name')} />
                {fieldErrors.first_name && <p className="text-xs text-red-400 mt-1">{fieldErrors.first_name}</p>}
              </div>
              <div>
                <label className={labelClass}>Last Name *</label>
                <input type="text" value={form.last_name} onChange={(e) => updateField('last_name', e.target.value)} className={inputClass('last_name')} />
                {fieldErrors.last_name && <p className="text-xs text-red-400 mt-1">{fieldErrors.last_name}</p>}
              </div>
              <div>
                <label className={labelClass}>SA ID Number</label>
                <input type="text" value={form.id_number} onChange={(e) => updateField('id_number', e.target.value)} className={inputClass('id_number')} placeholder="13 digits" maxLength={13} />
                {fieldErrors.id_number && <p className="text-xs text-red-400 mt-1">{fieldErrors.id_number}</p>}
              </div>
              <div>
                <label className={labelClass}>Tax Number</label>
                <input type="text" value={form.tax_number} onChange={(e) => updateField('tax_number', e.target.value)} className={inputClass('tax_number')} />
              </div>
            </div>
          </div>

          {/* Employment Details */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Employment Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Start Date *</label>
                <input type="date" value={form.start_date} onChange={(e) => updateField('start_date', e.target.value)} className={inputClass('start_date')} />
                {fieldErrors.start_date && <p className="text-xs text-red-400 mt-1">{fieldErrors.start_date}</p>}
              </div>
              <div>
                <label className={labelClass}>Department</label>
                <input type="text" value={form.department} onChange={(e) => updateField('department', e.target.value)} className={inputClass('department')} />
              </div>
              <div>
                <label className={labelClass}>Position</label>
                <input type="text" value={form.position} onChange={(e) => updateField('position', e.target.value)} className={inputClass('position')} />
              </div>
              <div>
                <label className={labelClass}>Employment Type</label>
                <select value={form.employment_type} onChange={(e) => updateField('employment_type', e.target.value)} className={inputClass('employment_type')}>
                  <option value="permanent">Permanent</option>
                  <option value="contract">Contract</option>
                  <option value="temporary">Temporary</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Pay Frequency</label>
                <select value={form.pay_frequency} onChange={(e) => updateField('pay_frequency', e.target.value)} className={inputClass('pay_frequency')}>
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
            </div>
          </div>

          {/* Banking Details */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Banking Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Bank Name</label>
                <select value={form.bank_name} onChange={(e) => updateField('bank_name', e.target.value)} className={inputClass('bank_name')}>
                  <option value="">Select bank...</option>
                  {SA_BANKS.map(bank => (
                    <option key={bank} value={bank}>{bank}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Account Number</label>
                <input type="text" value={form.bank_account_number} onChange={(e) => updateField('bank_account_number', e.target.value)} className={inputClass('bank_account_number')} />
              </div>
              <div>
                <label className={labelClass}>Branch Code</label>
                <input type="text" value={form.bank_branch_code} onChange={(e) => updateField('bank_branch_code', e.target.value)} className={inputClass('bank_branch_code')} />
              </div>
            </div>
          </div>

          {/* Pay Structure */}
          <div className="mb-8">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Pay Structure</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Basic Salary (Monthly) *</label>
                <input type="number" step="0.01" min="0" value={form.basic_salary} onChange={(e) => updateField('basic_salary', e.target.value)} className={inputClass('basic_salary')} placeholder="0.00" />
                {fieldErrors.basic_salary && <p className="text-xs text-red-400 mt-1">{fieldErrors.basic_salary}</p>}
              </div>
              <div>
                <label className={labelClass}>Travel Allowance</label>
                <input type="number" step="0.01" min="0" value={form.travel_allowance} onChange={(e) => updateField('travel_allowance', e.target.value)} className={inputClass('travel_allowance')} />
              </div>
              <div>
                <label className={labelClass}>Housing Allowance</label>
                <input type="number" step="0.01" min="0" value={form.housing_allowance} onChange={(e) => updateField('housing_allowance', e.target.value)} className={inputClass('housing_allowance')} />
              </div>
              <div>
                <label className={labelClass}>Cell Allowance</label>
                <input type="number" step="0.01" min="0" value={form.cell_allowance} onChange={(e) => updateField('cell_allowance', e.target.value)} className={inputClass('cell_allowance')} />
              </div>
              <div>
                <label className={labelClass}>Other Allowances</label>
                <input type="number" step="0.01" min="0" value={form.other_allowances} onChange={(e) => updateField('other_allowances', e.target.value)} className={inputClass('other_allowances')} />
              </div>
              <div>
                <label className={labelClass}>Medical Aid (Employer Contribution)</label>
                <input type="number" step="0.01" min="0" value={form.medical_aid_contribution} onChange={(e) => updateField('medical_aid_contribution', e.target.value)} className={inputClass('medical_aid_contribution')} />
              </div>
              <div>
                <label className={labelClass}>Retirement Fund Contribution (%)</label>
                <input type="number" step="0.01" min="0" max="27.5" value={form.retirement_fund_contribution_pct} onChange={(e) => updateField('retirement_fund_contribution_pct', e.target.value)} className={inputClass('retirement_fund_contribution_pct')} />
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-4 border-t border-[var(--ff-border-primary)]">
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Create Employee
            </button>
            <Link
              href="/payroll/employees"
              className="px-6 py-2.5 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
