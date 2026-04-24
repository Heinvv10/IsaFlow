/**
 * Payroll Employee Profile card — editable profile fields + Save button.
 * Used by /payroll/employees/[id].
 */
import { Loader2, Save } from 'lucide-react';

export interface Employee {
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
  costCentreId?: string | null;
  payScaleId?: string | null;
  occupationalLevelId?: string | null;
}

interface Props {
  employee: Employee;
  onChange: (e: Employee) => void;
  onSave: () => void;
  saving: boolean;
}

const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

export function EmployeeProfileCard({ employee, onChange, onSave, saving }: Props) {
  return (
    <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Profile</h2>
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-medium"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          Save
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={label}>First name</label>
          <input className={field} value={employee.firstName}
            onChange={e => onChange({ ...employee, firstName: e.target.value })} />
        </div>
        <div>
          <label className={label}>Last name</label>
          <input className={field} value={employee.lastName}
            onChange={e => onChange({ ...employee, lastName: e.target.value })} />
        </div>
        <div>
          <label className={label}>Tax number</label>
          <input className={field} value={employee.taxNumber ?? ''}
            onChange={e => onChange({ ...employee, taxNumber: e.target.value })} />
        </div>
        <div>
          <label className={label}>ID number</label>
          <input className={field} value={employee.idNumber ?? ''}
            onChange={e => onChange({ ...employee, idNumber: e.target.value })} />
        </div>
        <div>
          <label className={label}>Date of birth</label>
          <input type="date" className={field} value={employee.dateOfBirth?.slice(0, 10) ?? ''}
            onChange={e => onChange({ ...employee, dateOfBirth: e.target.value })} />
        </div>
        <div>
          <label className={label}>End date</label>
          <input type="date" className={field} value={employee.endDate?.slice(0, 10) ?? ''}
            onChange={e => onChange({ ...employee, endDate: e.target.value || undefined })} />
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" checked={employee.uifExcluded}
            onChange={e => onChange({ ...employee, uifExcluded: e.target.checked })} />
          UIF excluded
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" checked={employee.medicalAidMainMember}
            onChange={e => onChange({ ...employee, medicalAidMainMember: e.target.checked })} />
          Medical aid main member
        </label>
        <div>
          <label className={label}>Medical aid dependants</label>
          <input type="number" min="0" className={field} value={employee.medicalAidDependantsCount}
            onChange={e => onChange({ ...employee, medicalAidDependantsCount: Number(e.target.value) || 0 })} />
        </div>
      </div>
    </section>
  );
}
