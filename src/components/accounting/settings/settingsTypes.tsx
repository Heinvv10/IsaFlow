// ── Shared types & constants for Company Settings tabs ────────────────────────

export interface Company {
  id: string;
  name: string;
  tradingName: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  taxNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  country: string | null;
  logoData: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchCode: string | null;
  bankAccountType: string | null;
  financialYearStart: number;
  vatPeriod: string;
  vatPeriodAlignment: 'odd' | 'even';
  defaultCurrency: string | null;
  lockdownEnabled: boolean;
  lockdownDate: string | null;
  vatSystemType: string;
  entityType: string;
  registeredName: string | null;
  taxOffice: string | null;
  contactName: string | null;
  fax: string | null;
  mobile: string | null;
  physicalAddressLine1: string | null;
  physicalAddressLine2: string | null;
  physicalCity: string | null;
  physicalProvince: string | null;
  physicalPostalCode: string | null;
  taxPractitionerRegNumber: string | null;
  taxPractitionerName: string | null;
  sarsContactFirstName: string | null;
  sarsContactLastName: string | null;
  sarsContactCapacity: string | null;
  sarsContactNumber: string | null;
  sarsContactTelephone: string | null;
  logoPosition: string;
  logoOnEmails: boolean;
  logoOnPortal: boolean;
  roundingType: string;
  roundToNearest: number;
  qtyDecimalPlaces: number;
  valueDecimalPlaces: number;
  hoursDecimalPlaces: number;
  costPriceDecimalPlaces: number;
  sellingPriceDecimalPlaces: number;
  currencySymbol: string;
  dateFormat: string;
  emailUseForCommunication: boolean;
  emailAlwaysCc: boolean;
  emailUseServiceFrom: boolean;
  warnDuplicateCustomerRef: boolean;
  warnDuplicateSupplierInv: boolean;
  displayInactiveCustomersProcessing: boolean;
  displayInactiveSuppliersProcessing: boolean;
  displayInactiveCustomersReports: boolean;
  displayInactiveSuppliersReports: boolean;
  useInclusiveProcessing: boolean;
  useAccountDefaultLineType: boolean;
  warnItemQtyBelowZero: boolean;
  blockItemQtyBelowZero: boolean;
  warnItemCostZero: boolean;
  warnItemSellingBelowCost: boolean;
  displayInactiveItemsProcessing: boolean;
  displayInactiveItemsReports: boolean;
  salesOrdersReserveQty: boolean;
  displayInactiveBundles: boolean;
  ageingMonthly: boolean;
  ageingBasedOn: string;
  industry: string | null;
  businessStructure: string | null;
  socialFacebook: string | null;
  socialLinkedin: string | null;
  socialX: string | null;
}

export interface DocumentNumber {
  id: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}

export interface CompanyDocument {
  id: string;
  documentType: string;
  documentName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

export const INPUT_CLS = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none';
export const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';
export const SECTION_CLS = 'bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6';

export const DOC_TYPE_LABELS: Record<string, string> = {
  cipc_certificate: 'CIPC Registration Certificate',
  tax_clearance: 'Tax Clearance Certificate',
  bbbee_certificate: 'B-BBEE Certificate',
  vat_registration: 'VAT Registration Certificate',
  other: 'Other Document',
};

export const INDUSTRIES = [
  'Accounting & Financial Services', 'Agriculture', 'Automotive', 'Construction',
  'Education', 'Engineering', 'Healthcare', 'Hospitality', 'Information Technology',
  'Legal', 'Manufacturing', 'Mining', 'Property', 'Retail',
  'Telecommunications', 'Transport & Logistics', 'Other',
];

export const BUSINESS_STRUCTURES = [
  { value: 'sole_proprietor', label: 'Sole Proprietor' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'cc', label: 'Close Corporation (CC)' },
  { value: 'pty_ltd', label: 'Private Company (Pty Ltd)' },
  { value: 'ltd', label: 'Public Company (Ltd)' },
  { value: 'npc', label: 'Non-Profit Organisation (NPC)' },
  { value: 'trust', label: 'Trust' },
  { value: 'other', label: 'Other' },
];

export const ENTITY_TYPES = [
  { value: 'company', label: 'Company (Pty Ltd)' },
  { value: 'cc', label: 'Close Corporation (CC)' },
  { value: 'sole_proprietor', label: 'Sole Proprietor' },
  { value: 'trust', label: 'Trust' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'npc', label: 'Non-Profit Company (NPC)' },
  { value: 'other', label: 'Other' },
];

// ── Toggle ────────────────────────────────────────────────────────────────────

export function Toggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer py-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-teal-600' : 'bg-gray-600'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform mt-0.5 ${checked ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
      </button>
      <span className="text-sm text-[var(--ff-text-primary)]">{label}</span>
    </label>
  );
}
