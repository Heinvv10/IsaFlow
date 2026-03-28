/**
 * Employee Detail Page
 * View/edit employee details, pay history, payslip history.
 * Route: /payroll/employees/[employeeId]
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, Loader2, AlertCircle, ArrowLeft, Save, FileText } from 'lucide-react';
import Link from 'next/link';
import { notify } from '@/utils/toast';

interface PayStructure {
  id: string;
  basic_salary: number;
  travel_allowance: number;
  housing_allowance: number;
  cell_allowance: number;
  other_allowances: number;
  medical_aid_contribution: number;
  retirement_fund_contribution_pct: number;
  effective_from: string;
  effective_to: string | null;
}

interface PayslipSummary {
  id: string;
  payroll_run_id: string;
  gross_pay: number;
  paye: number;
  uif_employee: number;
  net_pay: number;
  created_at: string;
  period_start?: string;
  period_end?: string;
}

interface EmployeeDetail {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string | null;
  tax_number: string | null;
  start_date: string;
  termination_date: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  department: string | null;
  position: string | null;
  employment_type: string;
  pay_frequency: string;
  status: string;
  pay_structure: PayStructure | null;
  pay_history: PayStructure[];
  payslip_history: PayslipSummary[];
}

function formatCurrency(amount: number): string {
  return `R ${amount.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function EmployeeDetailPage() {
  const router = useRouter();
  const { employeeId } = router.query;

  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<'details' | 'pay_history' | 'payslips'>('details');

  const loadEmployee = useCallback(async () => {
    if (!employeeId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/payroll/employees-detail?id=${employeeId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data ?? json;
      setEmployee(data as EmployeeDetail);
    } catch {
      setError('Failed to load employee');
    } finally {
      setIsLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    loadEmployee();
  }, [loadEmployee]);

  function startEditing() {
    if (!employee) return;
    setEditForm({
      first_name: employee.first_name,
      last_name: employee.last_name,
      id_number: employee.id_number || '',
      tax_number: employee.tax_number || '',
      department: employee.department || '',
      position: employee.position || '',
      employment_type: employee.employment_type,
      status: employee.status,
      bank_name: employee.bank_name || '',
      bank_account_number: employee.bank_account_number || '',
      bank_branch_code: employee.bank_branch_code || '',
      basic_salary: String(employee.pay_structure?.basic_salary || 0),
      travel_allowance: String(employee.pay_structure?.travel_allowance || 0),
      housing_allowance: String(employee.pay_structure?.housing_allowance || 0),
      cell_allowance: String(employee.pay_structure?.cell_allowance || 0),
      other_allowances: String(employee.pay_structure?.other_allowances || 0),
      medical_aid_contribution: String(employee.pay_structure?.medical_aid_contribution || 0),
      retirement_fund_contribution_pct: String(employee.pay_structure?.retirement_fund_contribution_pct || 0),
    });
    setIsEditing(true);
  }

  async function handleSave() {
    if (!employee) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/payroll/employees-detail?id=${employee.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editForm,
          basic_salary: Number(editForm.basic_salary),
          travel_allowance: Number(editForm.travel_allowance || 0),
          housing_allowance: Number(editForm.housing_allowance || 0),
          cell_allowance: Number(editForm.cell_allowance || 0),
          other_allowances: Number(editForm.other_allowances || 0),
          medical_aid_contribution: Number(editForm.medical_aid_contribution || 0),
          retirement_fund_contribution_pct: Number(editForm.retirement_fund_contribution_pct || 0),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? json.message ?? `HTTP ${res.status}`);
      notify.success('Employee updated successfully');
      setIsEditing(false);
      loadEmployee();
    } catch (err: unknown) {
      notify.error(err instanceof Error ? err.message : 'Failed to update employee');
    } finally {
      setIsSaving(false);
    }
  }

  const inputClass = 'w-full px-3 py-1.5 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error || !employee) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center gap-2 text-red-400 py-12">
          <AlertCircle className="h-5 w-5" />
          <span>{error || 'Employee not found'}</span>
        </div>
      </AppLayout>
    );
  }

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
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
                  {employee.first_name} {employee.last_name}
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {employee.employee_number} | {employee.department || 'No department'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isEditing ? (
                <>
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors"
                  >
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </button>
                  <button
                    onClick={() => setIsEditing(false)}
                    className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] text-sm font-medium transition-colors hover:bg-[var(--ff-bg-tertiary)]"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={startEditing}
                  className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
                >
                  Edit
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 flex gap-1">
            {(['details', 'pay_history', 'payslips'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab
                    ? 'border-teal-500 text-teal-400'
                    : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                }`}
              >
                {tab === 'details' ? 'Details' : tab === 'pay_history' ? 'Pay History' : 'Payslips'}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 max-w-4xl">
          {/* Details Tab */}
          {activeTab === 'details' && (
            <div className="space-y-8">
              {/* Personal */}
              <section>
                <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-3">Personal Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {isEditing ? (
                    <>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">First Name</label><input className={inputClass} value={editForm.first_name} onChange={e => setEditForm(p => ({ ...p, first_name: e.target.value }))} /></div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Last Name</label><input className={inputClass} value={editForm.last_name} onChange={e => setEditForm(p => ({ ...p, last_name: e.target.value }))} /></div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">ID Number</label><input className={inputClass} value={editForm.id_number} onChange={e => setEditForm(p => ({ ...p, id_number: e.target.value }))} /></div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Tax Number</label><input className={inputClass} value={editForm.tax_number} onChange={e => setEditForm(p => ({ ...p, tax_number: e.target.value }))} /></div>
                    </>
                  ) : (
                    <>
                      <DetailField label="First Name" value={employee.first_name} />
                      <DetailField label="Last Name" value={employee.last_name} />
                      <DetailField label="ID Number" value={employee.id_number || '-'} />
                      <DetailField label="Tax Number" value={employee.tax_number || '-'} />
                      <DetailField label="Start Date" value={formatDate(employee.start_date)} />
                      <DetailField label="Status" value={employee.status} />
                    </>
                  )}
                </div>
              </section>

              {/* Employment */}
              <section>
                <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-3">Employment</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {isEditing ? (
                    <>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Department</label><input className={inputClass} value={editForm.department} onChange={e => setEditForm(p => ({ ...p, department: e.target.value }))} /></div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Position</label><input className={inputClass} value={editForm.position} onChange={e => setEditForm(p => ({ ...p, position: e.target.value }))} /></div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Employment Type</label>
                        <select className={inputClass} value={editForm.employment_type} onChange={e => setEditForm(p => ({ ...p, employment_type: e.target.value }))}>
                          <option value="permanent">Permanent</option><option value="contract">Contract</option><option value="temporary">Temporary</option>
                        </select>
                      </div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Status</label>
                        <select className={inputClass} value={editForm.status} onChange={e => setEditForm(p => ({ ...p, status: e.target.value }))}>
                          <option value="active">Active</option><option value="inactive">Inactive</option>
                        </select>
                      </div>
                    </>
                  ) : (
                    <>
                      <DetailField label="Department" value={employee.department || '-'} />
                      <DetailField label="Position" value={employee.position || '-'} />
                      <DetailField label="Employment Type" value={employee.employment_type} />
                      <DetailField label="Pay Frequency" value={employee.pay_frequency} />
                    </>
                  )}
                </div>
              </section>

              {/* Banking */}
              <section>
                <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-3">Banking Details</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {isEditing ? (
                    <>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Bank Name</label><input className={inputClass} value={editForm.bank_name} onChange={e => setEditForm(p => ({ ...p, bank_name: e.target.value }))} /></div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Account Number</label><input className={inputClass} value={editForm.bank_account_number} onChange={e => setEditForm(p => ({ ...p, bank_account_number: e.target.value }))} /></div>
                      <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Branch Code</label><input className={inputClass} value={editForm.bank_branch_code} onChange={e => setEditForm(p => ({ ...p, bank_branch_code: e.target.value }))} /></div>
                    </>
                  ) : (
                    <>
                      <DetailField label="Bank" value={employee.bank_name || '-'} />
                      <DetailField label="Account Number" value={employee.bank_account_number || '-'} />
                      <DetailField label="Branch Code" value={employee.bank_branch_code || '-'} />
                    </>
                  )}
                </div>
              </section>

              {/* Current Pay Structure */}
              <section>
                <h3 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-3">Current Pay Structure</h3>
                {employee.pay_structure ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {isEditing ? (
                      <>
                        <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Basic Salary</label><input type="number" step="0.01" className={inputClass} value={editForm.basic_salary} onChange={e => setEditForm(p => ({ ...p, basic_salary: e.target.value }))} /></div>
                        <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Travel Allowance</label><input type="number" step="0.01" className={inputClass} value={editForm.travel_allowance} onChange={e => setEditForm(p => ({ ...p, travel_allowance: e.target.value }))} /></div>
                        <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Housing Allowance</label><input type="number" step="0.01" className={inputClass} value={editForm.housing_allowance} onChange={e => setEditForm(p => ({ ...p, housing_allowance: e.target.value }))} /></div>
                        <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Cell Allowance</label><input type="number" step="0.01" className={inputClass} value={editForm.cell_allowance} onChange={e => setEditForm(p => ({ ...p, cell_allowance: e.target.value }))} /></div>
                        <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Other Allowances</label><input type="number" step="0.01" className={inputClass} value={editForm.other_allowances} onChange={e => setEditForm(p => ({ ...p, other_allowances: e.target.value }))} /></div>
                        <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Medical Aid (Employer)</label><input type="number" step="0.01" className={inputClass} value={editForm.medical_aid_contribution} onChange={e => setEditForm(p => ({ ...p, medical_aid_contribution: e.target.value }))} /></div>
                        <div><label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Retirement Fund (%)</label><input type="number" step="0.01" className={inputClass} value={editForm.retirement_fund_contribution_pct} onChange={e => setEditForm(p => ({ ...p, retirement_fund_contribution_pct: e.target.value }))} /></div>
                      </>
                    ) : (
                      <>
                        <DetailField label="Basic Salary" value={formatCurrency(employee.pay_structure.basic_salary)} />
                        <DetailField label="Travel Allowance" value={formatCurrency(employee.pay_structure.travel_allowance)} />
                        <DetailField label="Housing Allowance" value={formatCurrency(employee.pay_structure.housing_allowance)} />
                        <DetailField label="Cell Allowance" value={formatCurrency(employee.pay_structure.cell_allowance)} />
                        <DetailField label="Other Allowances" value={formatCurrency(employee.pay_structure.other_allowances)} />
                        <DetailField label="Medical Aid (Employer)" value={formatCurrency(employee.pay_structure.medical_aid_contribution)} />
                        <DetailField label="Retirement Fund (%)" value={`${employee.pay_structure.retirement_fund_contribution_pct}%`} />
                        <DetailField label="Effective From" value={formatDate(employee.pay_structure.effective_from)} />
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-[var(--ff-text-tertiary)]">No pay structure defined</p>
                )}
              </section>
            </div>
          )}

          {/* Pay History Tab */}
          {activeTab === 'pay_history' && (
            <div>
              {employee.pay_history && employee.pay_history.length > 0 ? (
                <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                        <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Effective From</th>
                        <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Effective To</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Basic Salary</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Travel</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Housing</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Total Package</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employee.pay_history.map((ph) => (
                        <tr key={ph.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                          <td className="py-3 px-4 text-[var(--ff-text-primary)]">{formatDate(ph.effective_from)}</td>
                          <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{ph.effective_to ? formatDate(ph.effective_to) : 'Current'}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(ph.basic_salary)}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(ph.travel_allowance)}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(ph.housing_allowance)}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">
                            {formatCurrency(ph.basic_salary + ph.travel_allowance + ph.housing_allowance + ph.cell_allowance + ph.other_allowances)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-[var(--ff-text-tertiary)] text-center py-12">No pay history available</p>
              )}
            </div>
          )}

          {/* Payslips Tab */}
          {activeTab === 'payslips' && (
            <div>
              {employee.payslip_history && employee.payslip_history.length > 0 ? (
                <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                        <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Period</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Gross</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">PAYE</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF</th>
                        <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Net Pay</th>
                        <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employee.payslip_history.map((ps) => (
                        <tr key={ps.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                          <td className="py-3 px-4 text-[var(--ff-text-primary)]">{formatDate(ps.created_at)}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(ps.gross_pay)}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(ps.paye)}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(ps.uif_employee)}</td>
                          <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)] font-medium">{formatCurrency(ps.net_pay)}</td>
                          <td className="py-3 px-4">
                            <a
                              href={`/api/payroll/payslip-pdf?id=${ps.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300 text-xs font-medium transition-colors"
                            >
                              <FileText className="h-3 w-3" />
                              PDF
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-[var(--ff-text-tertiary)] text-center py-12">No payslips generated yet</p>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--ff-text-tertiary)]">{label}</dt>
      <dd className="text-sm text-[var(--ff-text-primary)] mt-0.5">{value}</dd>
    </div>
  );
}
