/** Shared state and prop shapes for the employee create form sections. */
import type { FieldValidity } from '@/components/ui/useParsedField';
import { isValidSaIdNumber, isValidSarsTaxNumber } from '@/modules/accounting/services/payroll/employeeFieldRules';

export type EmploymentType = 'permanent' | 'contract' | 'casual' | 'director';

export interface FormState {
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
  /** Integer cents, as MoneyField reports them. Null: no salary on create. */
  salaryCents: number | null;
  salaryComponentId: string;
}

/** Fields that can fail validation, in the order they appear on the page (focus goes to the first). */
export type FieldKey = 'firstName' | 'lastName' | 'idNumber' | 'dateOfBirth' | 'employeeNumber' | 'startDate'
  | 'taxNumber' | 'salaryCents' | 'salaryComponentId';
export type DateKey = 'dateOfBirth' | 'startDate';
/** Parsed fields: text they refused reports null, which is not the same as left empty. */
export type RefusedKey = DateKey | 'salaryCents';
export type FormErrors = Partial<Record<FieldKey, string>>;

export const FIELD_ORDER: readonly FieldKey[] = [
  'firstName', 'lastName', 'idNumber', 'dateOfBirth', 'employeeNumber', 'startDate',
  'taxNumber', 'salaryCents', 'salaryComponentId',
];

/** Medical aid stays off by default (D1): a new employee is not assumed to have a tax credit. */
export const initialForm = (today: string): FormState => ({
  firstName: '', lastName: '', employeeNumber: '',
  employmentType: 'permanent', startDate: today,
  idNumber: '', taxNumber: '', dateOfBirth: '',
  uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: '0',
  salaryCents: null, salaryComponentId: '',
});

export interface SectionProps {
  form: FormState;
  errors: FormErrors;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  fieldRef: (k: FieldKey) => (el: HTMLElement | null) => void;
  setDate: (k: DateKey) => (iso: string | null, validity: FieldValidity) => void;
  /** Judge one field now, on blur, rather than at submit. */
  checkField: (k: FieldKey) => void;
}

/** What the form refuses before it posts. A refused date (`refused`) is not an empty one. */
export function validateForm(form: FormState, refused: Partial<Record<RefusedKey, string>>): FormErrors {
  const errors: FormErrors = {};
  if (!form.firstName.trim()) errors.firstName = 'Enter a first name.';
  if (!form.lastName.trim()) errors.lastName = 'Enter a last name.';
  if (form.idNumber && !isValidSaIdNumber(form.idNumber)) errors.idNumber = 'Enter the 13 digits of the SA ID number.';
  if (refused.dateOfBirth) errors.dateOfBirth = refused.dateOfBirth;
  if (!form.employeeNumber.trim()) errors.employeeNumber = 'Enter an employee number.';
  if (refused.startDate) errors.startDate = refused.startDate;
  else if (!form.startDate) errors.startDate = 'Enter a start date.';
  if (form.taxNumber && !isValidSarsTaxNumber(form.taxNumber)) {
    errors.taxNumber = 'A SARS tax number is 10 digits starting with 0, 1, 2, 3 or 9.';
  }
  if (refused.salaryCents) errors.salaryCents = refused.salaryCents;
  else if (form.salaryCents !== null && !form.salaryComponentId) errors.salaryComponentId = 'Choose the pay component.';
  return errors;
}

/** The POST /api/payroll/employees body. Same keys, same order, same coercions as before the kit, plus `salary` (amountCents). */
export const buildBody = (form: FormState) => ({
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
  salary: form.salaryCents !== null && form.salaryComponentId
    ? { componentId: form.salaryComponentId, amountCents: form.salaryCents }
    : undefined,
});
