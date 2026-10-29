/** Shared state and prop shapes for the employee create form sections. */
import type { FieldValidity } from '@/components/ui/useParsedField';

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
}

/** Fields that can fail validation, in the order they appear on the page (focus goes to the first). */
export type FieldKey = 'firstName' | 'lastName' | 'dateOfBirth' | 'employeeNumber' | 'startDate';
export type DateKey = 'dateOfBirth' | 'startDate';
export type FormErrors = Partial<Record<FieldKey, string>>;

export const FIELD_ORDER: readonly FieldKey[] = ['firstName', 'lastName', 'dateOfBirth', 'employeeNumber', 'startDate'];

/** Medical aid stays off by default (D1): a new employee is not assumed to have a tax credit. */
export const initialForm = (today: string): FormState => ({
  firstName: '', lastName: '', employeeNumber: '',
  employmentType: 'permanent', startDate: today,
  idNumber: '', taxNumber: '', dateOfBirth: '',
  uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: '0',
});

export interface SectionProps {
  form: FormState;
  errors: FormErrors;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  fieldRef: (k: FieldKey) => (el: HTMLInputElement | null) => void;
  setDate: (k: DateKey) => (iso: string | null, validity: FieldValidity) => void;
}

/** What the form refuses before it posts. A refused date (`refused`) is not an empty one. */
export function validateForm(form: FormState, refused: Partial<Record<DateKey, string>>): FormErrors {
  const errors: FormErrors = {};
  if (!form.firstName.trim()) errors.firstName = 'Enter a first name.';
  if (!form.lastName.trim()) errors.lastName = 'Enter a last name.';
  if (refused.dateOfBirth) errors.dateOfBirth = refused.dateOfBirth;
  if (!form.employeeNumber.trim()) errors.employeeNumber = 'Enter an employee number.';
  if (refused.startDate) errors.startDate = refused.startDate;
  else if (!form.startDate) errors.startDate = 'Enter a start date.';
  return errors;
}

/** The POST /api/payroll/employees body. Same keys, same order, same coercions as before the kit. */
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
});
