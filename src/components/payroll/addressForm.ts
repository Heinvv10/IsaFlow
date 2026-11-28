/**
 * The employee address as the create form and the profile card enter it (wave 7 EA1, W5). The rules are the server's
 * own (parseEmployeeAddress: SARS BRS V25.3.0 codes 3211-3217, 3285, 3288-3294), run here first so the person is told
 * on the field; the server judges again. One writer: PUT /api/payroll/employees/[id]/address.
 */
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { parseEmployeeAddress, type EmployeeAddress } from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';

/** Each field, in tab order: form key, the server's error key, its label and whether the BRS makes it mandatory. */
export const ADDRESS_FIELDS = [
  { key: 'unitNumber', path: 'residential.unitNumber', label: 'Unit number', part: 'res', mandatory: false },
  { key: 'complex', path: 'residential.complex', label: 'Complex', part: 'res', mandatory: false },
  { key: 'streetNumber', path: 'residential.streetNumber', label: 'Street number', part: 'res', mandatory: false },
  { key: 'street', path: 'residential.street', label: 'Street or farm name', part: 'res', mandatory: true },
  { key: 'suburb', path: 'residential.suburb', label: 'Suburb or district', part: 'res', mandatory: false },
  { key: 'city', path: 'residential.city', label: 'City or town', part: 'res', mandatory: false },
  { key: 'postalCode', path: 'residential.postalCode', label: 'Postal code', part: 'res', mandatory: false },
  { key: 'countryCode', path: 'residential.countryCode', label: 'Country code', part: 'res', mandatory: true },
  { key: 'line1', path: 'postal.line1', label: 'Postal address line 1', part: 'post', mandatory: true },
  { key: 'line2', path: 'postal.line2', label: 'Postal address line 2', part: 'post', mandatory: false },
  { key: 'line3', path: 'postal.line3', label: 'Postal address line 3', part: 'post', mandatory: false },
  { key: 'line4', path: 'postal.line4', label: 'Postal address line 4', part: 'post', mandatory: false },
  { key: 'postalPostalCode', path: 'postal.postalCode', label: 'Postal code (postal address)', part: 'post', mandatory: false },
  { key: 'postalCountryCode', path: 'postal.countryCode', label: 'Country code (postal address)', part: 'post', mandatory: true },
] as const;

export type AddressFieldKey = typeof ADDRESS_FIELDS[number]['key'];
export type AddressForm = Record<AddressFieldKey, string> & { sameAsResidential: boolean };
/** Field errors keyed by the server's dotted path ("residential.postalCode"). */
export type AddressErrors = Record<string, string[]>;

export function addressFormOf(a: EmployeeAddress | null): AddressForm {
  const r = a?.residential;
  const p = a && !a.postal.sameAsResidential ? a.postal : null;
  return {
    unitNumber: r?.unitNumber ?? '', complex: r?.complex ?? '', streetNumber: r?.streetNumber ?? '', street: r?.street ?? '',
    suburb: r?.suburb ?? '', city: r?.city ?? '', postalCode: r?.postalCode ?? '', countryCode: r?.countryCode ?? 'ZA',
    sameAsResidential: a ? a.postal.sameAsResidential : true,
    line1: p?.line1 ?? '', line2: p?.line2 ?? '', line3: p?.line3 ?? '', line4: p?.line4 ?? '',
    postalPostalCode: p?.postalCode ?? '', postalCountryCode: p?.countryCode ?? 'ZA',
  };
}

export const emptyAddressForm = (): AddressForm => addressFormOf(null);

/** Nothing typed: the country codes and the "same as residential" tick have defaults, so they do not count. */
export const addressIsBlank = (f: AddressForm): boolean => ADDRESS_FIELDS
  .filter((d) => d.key !== 'countryCode' && d.key !== 'postalCountryCode')
  .every((d) => (d.part === 'post' && f.sameAsResidential) || !f[d.key].trim());

export function addressBodyOf(f: AddressForm): unknown {
  return {
    residential: { unitNumber: f.unitNumber, complex: f.complex, streetNumber: f.streetNumber, street: f.street, suburb: f.suburb, city: f.city, postalCode: f.postalCode, countryCode: f.countryCode },
    postal: f.sameAsResidential ? { sameAsResidential: true } : {
      sameAsResidential: false, line1: f.line1, line2: f.line2, line3: f.line3, line4: f.line4, postalCode: f.postalPostalCode, countryCode: f.postalCountryCode,
    },
  };
}

/** The server's checks, run in the browser: the errors and the first field (in page order) that failed. */
export function validateAddressForm(f: AddressForm): { errors: AddressErrors; first: AddressFieldKey | null } {
  const parsed = parseEmployeeAddress(addressBodyOf(f));
  if (parsed.ok) return { errors: {}, first: null };
  return { errors: parsed.fieldErrors, first: ADDRESS_FIELDS.find((d) => parsed.fieldErrors[d.path]?.length)?.key ?? null };
}

export async function saveEmployeeAddress(employeeId: string, f: AddressForm): Promise<void> {
  const res = await apiFetch(`/api/payroll/employees/${employeeId}/address`, { method: 'PUT', body: JSON.stringify(addressBodyOf(f)) });
  await assertOk(res, 'Could not save the address - try again');
}
