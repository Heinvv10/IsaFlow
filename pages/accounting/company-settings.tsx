/**
 * Company Settings — Full Sage-parity settings page
 * Tabs: Company Details | General Settings | VAT Settings | Documents & Statements | Branding
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Save, Loader2, AlertCircle, CheckCircle2, Upload, Trash2, Download, FileText, Lock, FileDigit, Settings2, Receipt, Palette, Layers } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';

// ── Types ────────────────────────────────────────────────────────────────────

interface Company {
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
  // Lockdown
  lockdownEnabled: boolean;
  lockdownDate: string | null;
  // VAT system
  vatSystemType: string;
  // Entity & statutory
  entityType: string;
  registeredName: string | null;
  taxOffice: string | null;
  contactName: string | null;
  fax: string | null;
  mobile: string | null;
  // Physical address
  physicalAddressLine1: string | null;
  physicalAddressLine2: string | null;
  physicalCity: string | null;
  physicalProvince: string | null;
  physicalPostalCode: string | null;
  // Tax practitioner
  taxPractitionerRegNumber: string | null;
  taxPractitionerName: string | null;
  // SARS contact
  sarsContactFirstName: string | null;
  sarsContactLastName: string | null;
  sarsContactCapacity: string | null;
  sarsContactNumber: string | null;
  sarsContactTelephone: string | null;
  // Branding
  logoPosition: string;
  logoOnEmails: boolean;
  logoOnPortal: boolean;
  // Regional
  roundingType: string;
  roundToNearest: number;
  qtyDecimalPlaces: number;
  valueDecimalPlaces: number;
  hoursDecimalPlaces: number;
  costPriceDecimalPlaces: number;
  sellingPriceDecimalPlaces: number;
  currencySymbol: string;
  dateFormat: string;
  // Email
  emailUseForCommunication: boolean;
  emailAlwaysCc: boolean;
  emailUseServiceFrom: boolean;
  // Customer & Supplier
  warnDuplicateCustomerRef: boolean;
  warnDuplicateSupplierInv: boolean;
  displayInactiveCustomersProcessing: boolean;
  displayInactiveSuppliersProcessing: boolean;
  displayInactiveCustomersReports: boolean;
  displayInactiveSuppliersReports: boolean;
  useInclusiveProcessing: boolean;
  useAccountDefaultLineType: boolean;
  // Items
  warnItemQtyBelowZero: boolean;
  blockItemQtyBelowZero: boolean;
  warnItemCostZero: boolean;
  warnItemSellingBelowCost: boolean;
  displayInactiveItemsProcessing: boolean;
  displayInactiveItemsReports: boolean;
  salesOrdersReserveQty: boolean;
  displayInactiveBundles: boolean;
  // Ageing
  ageingMonthly: boolean;
  ageingBasedOn: string;
  // Org classification
  industry: string | null;
  businessStructure: string | null;
  // Social media
  socialFacebook: string | null;
  socialLinkedin: string | null;
  socialX: string | null;
}

interface DocumentNumber {
  id: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  padding: number;
}

interface CompanyMessage {
  messageType: string;
  message: string;
}

interface CompanyDocument {
  id: string;
  documentType: string;
  documentName: string;
  mimeType: string;
  fileSize: number;
  createdAt: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<string, string> = {
  cipc_certificate: 'CIPC Registration Certificate',
  tax_clearance: 'Tax Clearance Certificate',
  bbbee_certificate: 'B-BBEE Certificate',
  vat_registration: 'VAT Registration Certificate',
  other: 'Other Document',
};

const DOC_NUMBER_LABELS: Record<string, string> = {
  quotation: 'Quotation', sales_order: 'Sales Order', customer_invoice: 'Customer Invoice',
  credit_note: 'Credit Note', customer_receipt: 'Customer Receipt', customer_write_off: 'Customer Write-Off',
  recurring_invoice: 'Recurring Invoice', customer_adjustment: 'Customer Adjustment',
  purchase_order: 'Purchase Order', supplier_invoice: 'Supplier Invoice',
  supplier_return: 'Supplier Return', supplier_payment: 'Supplier Payment',
  supplier_adjustment: 'Supplier Adjustment', delivery_note: 'Delivery Note',
};

const STATEMENT_MSG_TYPES = [
  { key: 'statement_current', label: 'Current' },
  { key: 'statement_30', label: 'In 30 Days' },
  { key: 'statement_60', label: 'In 60 Days' },
  { key: 'statement_90', label: 'In 90 Days' },
  { key: 'statement_120', label: 'In 120+ Days' },
];

const CUSTOMER_MSG_TYPES = [
  { key: 'msg_customer_quote', label: 'Quote' },
  { key: 'msg_customer_so', label: 'Sales Order' },
  { key: 'msg_customer_invoice', label: 'Customer Invoice' },
  { key: 'msg_customer_credit_note', label: 'Credit Note' },
  { key: 'msg_customer_receipt', label: 'Receipt' },
  { key: 'msg_customer_write_off', label: 'Write-Off' },
  { key: 'msg_customer_bad_debt_relief', label: 'Bad Debt Relief' },
  { key: 'msg_customer_bad_debt_recovered', label: 'Bad Debt Recovered' },
];

const SUPPLIER_MSG_TYPES = [
  { key: 'msg_supplier_po', label: 'Purchase Order' },
  { key: 'msg_supplier_invoice', label: 'Supplier Invoice' },
  { key: 'msg_supplier_return', label: 'Supplier Return' },
  { key: 'msg_supplier_payment', label: 'Payment' },
  { key: 'msg_supplier_output_tax_adj', label: 'Output Tax Adjustment' },
  { key: 'msg_supplier_input_tax_adj', label: 'Input Tax Adjustment' },
];

const INDUSTRIES = [
  'Accounting & Financial Services', 'Agriculture', 'Automotive', 'Construction',
  'Education', 'Engineering', 'Healthcare', 'Hospitality', 'Information Technology',
  'Legal', 'Manufacturing', 'Mining', 'Property', 'Retail',
  'Telecommunications', 'Transport & Logistics', 'Other',
];

const BUSINESS_STRUCTURES = [
  { value: 'sole_proprietor', label: 'Sole Proprietor' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'cc', label: 'Close Corporation (CC)' },
  { value: 'pty_ltd', label: 'Private Company (Pty Ltd)' },
  { value: 'ltd', label: 'Public Company (Ltd)' },
  { value: 'npc', label: 'Non-Profit Organisation (NPC)' },
  { value: 'trust', label: 'Trust' },
  { value: 'other', label: 'Other' },
];

const ENTITY_TYPES = [
  { value: 'company', label: 'Company (Pty Ltd)' },
  { value: 'cc', label: 'Close Corporation (CC)' },
  { value: 'sole_proprietor', label: 'Sole Proprietor' },
  { value: 'trust', label: 'Trust' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'npc', label: 'Non-Profit Company (NPC)' },
  { value: 'other', label: 'Other' },
];

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none';
const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';
const SECTION_CLS = 'bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6';

type TabId = 'details' | 'general' | 'vat' | 'documents' | 'branding' | 'dimensions';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'details', label: 'Company Details', icon: <Building2 className="h-4 w-4" /> },
  { id: 'general', label: 'General Settings', icon: <Settings2 className="h-4 w-4" /> },
  { id: 'vat', label: 'VAT Settings', icon: <Receipt className="h-4 w-4" /> },
  { id: 'documents', label: 'Documents & Statements', icon: <FileDigit className="h-4 w-4" /> },
  { id: 'branding', label: 'Branding', icon: <Palette className="h-4 w-4" /> },
  { id: 'dimensions', label: 'Dimensions', icon: <Layers className="h-4 w-4" /> },
];

// ── Toggle Component ─────────────────────────────────────────────────────────

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
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

// ── Main Component ───────────────────────────────────────────────────────────

export default function CompanySettingsPage() {
  const { activeCompany } = useCompany();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('details');

  // Logo
  const [uploadingLogo, setUploadingLogo] = useState(false);

  // Dimensions
  const [enableCC, setEnableCC] = useState(false);
  const [enableBU, setEnableBU] = useState(false);
  const [dimLoaded, setDimLoaded] = useState(false);

  // Documents
  const [documents, setDocuments] = useState<CompanyDocument[]>([]);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [docType, setDocType] = useState('cipc_certificate');

  // Document numbers
  const [docNumbers, setDocNumbers] = useState<DocumentNumber[]>([]);

  // Messages
  const [messages, setMessages] = useState<Record<string, string>>({});

  // Physical address — "same as postal" UI toggle (pure client state)
  const [physicalSameAsPostal, setPhysicalSameAsPostal] = useState(false);

  // Document display fields
  const [docDisplayFields, setDocDisplayFields] = useState<Record<string, boolean>>({
    registrationNumber: true,
    vatNumber: true,
    companyDirectors: false,
    physicalAddress: false,
    phoneNumber: true,
    emailAddress: true,
    website: false,
    socialMediaLinks: false,
  });

  // ── Fetchers ─────────────────────────────────────────────────────────────

  const fetchCompany = useCallback(async (companyId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/companies?id=${companyId}`);
      const json = await res.json();
      const c = json.data;
      if (c) {
        setCompany({
          id: c.id,
          name: c.name,
          tradingName: c.tradingName ?? c.trading_name ?? null,
          registrationNumber: c.registrationNumber ?? c.registration_number ?? null,
          vatNumber: c.vatNumber ?? c.vat_number ?? null,
          taxNumber: c.taxNumber ?? c.tax_number ?? null,
          addressLine1: c.addressLine1 ?? c.address_line1 ?? null,
          addressLine2: c.addressLine2 ?? c.address_line2 ?? null,
          city: c.city ?? null,
          province: c.province ?? null,
          postalCode: c.postalCode ?? c.postal_code ?? null,
          phone: c.phone ?? null,
          email: c.email ?? null,
          website: c.website ?? null,
          country: c.country ?? 'South Africa',
          logoData: c.logoData ?? c.logo_data ?? null,
          bankName: c.bankName ?? c.bank_name ?? null,
          bankAccountNumber: c.bankAccountNumber ?? c.bank_account_number ?? null,
          bankBranchCode: c.bankBranchCode ?? c.bank_branch_code ?? null,
          bankAccountType: c.bankAccountType ?? c.bank_account_type ?? null,
          financialYearStart: c.financialYearStart ?? c.financial_year_start ?? 3,
          vatPeriod: c.vatPeriod ?? c.vat_period ?? 'bi-monthly',
          vatPeriodAlignment: c.vatPeriodAlignment ?? c.vat_period_alignment ?? 'odd',
          defaultCurrency: c.defaultCurrency ?? c.default_currency ?? 'ZAR',
          // New fields
          lockdownEnabled: c.lockdownEnabled ?? c.lockdown_enabled ?? false,
          lockdownDate: c.lockdownDate ?? c.lockdown_date ?? null,
          vatSystemType: c.vatSystemType ?? c.vat_system_type ?? 'invoice',
          entityType: c.entityType ?? c.entity_type ?? 'company',
          registeredName: c.registeredName ?? c.registered_name ?? null,
          taxOffice: c.taxOffice ?? c.tax_office ?? null,
          contactName: c.contactName ?? c.contact_name ?? null,
          fax: c.fax ?? null,
          mobile: c.mobile ?? null,
          physicalAddressLine1: c.physicalAddressLine1 ?? c.physical_address_line1 ?? null,
          physicalAddressLine2: c.physicalAddressLine2 ?? c.physical_address_line2 ?? null,
          physicalCity: c.physicalCity ?? c.physical_city ?? null,
          physicalProvince: c.physicalProvince ?? c.physical_province ?? null,
          physicalPostalCode: c.physicalPostalCode ?? c.physical_postal_code ?? null,
          taxPractitionerRegNumber: c.taxPractitionerRegNumber ?? c.tax_practitioner_reg_number ?? null,
          taxPractitionerName: c.taxPractitionerName ?? c.tax_practitioner_name ?? null,
          sarsContactFirstName: c.sarsContactFirstName ?? c.sars_contact_first_name ?? null,
          sarsContactLastName: c.sarsContactLastName ?? c.sars_contact_last_name ?? null,
          sarsContactCapacity: c.sarsContactCapacity ?? c.sars_contact_capacity ?? null,
          sarsContactNumber: c.sarsContactNumber ?? c.sars_contact_number ?? null,
          sarsContactTelephone: c.sarsContactTelephone ?? c.sars_contact_telephone ?? null,
          logoPosition: c.logoPosition ?? c.logo_position ?? 'top-left',
          logoOnEmails: c.logoOnEmails ?? c.logo_on_emails ?? true,
          logoOnPortal: c.logoOnPortal ?? c.logo_on_portal ?? true,
          roundingType: c.roundingType ?? c.rounding_type ?? 'none',
          roundToNearest: c.roundToNearest ?? c.round_to_nearest ?? 0,
          qtyDecimalPlaces: c.qtyDecimalPlaces ?? c.qty_decimal_places ?? 2,
          valueDecimalPlaces: c.valueDecimalPlaces ?? c.value_decimal_places ?? 2,
          hoursDecimalPlaces: c.hoursDecimalPlaces ?? c.hours_decimal_places ?? 2,
          costPriceDecimalPlaces: c.costPriceDecimalPlaces ?? c.cost_price_decimal_places ?? 2,
          sellingPriceDecimalPlaces: c.sellingPriceDecimalPlaces ?? c.selling_price_decimal_places ?? 2,
          currencySymbol: c.currencySymbol ?? c.currency_symbol ?? 'R',
          dateFormat: c.dateFormat ?? c.date_format ?? 'dd/mm/yyyy',
          emailUseForCommunication: c.emailUseForCommunication ?? c.email_use_for_communication ?? true,
          emailAlwaysCc: c.emailAlwaysCc ?? c.email_always_cc ?? false,
          emailUseServiceFrom: c.emailUseServiceFrom ?? c.email_use_service_from ?? false,
          warnDuplicateCustomerRef: c.warnDuplicateCustomerRef ?? c.warn_duplicate_customer_ref ?? true,
          warnDuplicateSupplierInv: c.warnDuplicateSupplierInv ?? c.warn_duplicate_supplier_inv ?? true,
          displayInactiveCustomersProcessing: c.displayInactiveCustomersProcessing ?? c.display_inactive_customers_processing ?? false,
          displayInactiveSuppliersProcessing: c.displayInactiveSuppliersProcessing ?? c.display_inactive_suppliers_processing ?? false,
          displayInactiveCustomersReports: c.displayInactiveCustomersReports ?? c.display_inactive_customers_reports ?? false,
          displayInactiveSuppliersReports: c.displayInactiveSuppliersReports ?? c.display_inactive_suppliers_reports ?? false,
          useInclusiveProcessing: c.useInclusiveProcessing ?? c.use_inclusive_processing ?? true,
          useAccountDefaultLineType: c.useAccountDefaultLineType ?? c.use_account_default_line_type ?? false,
          warnItemQtyBelowZero: c.warnItemQtyBelowZero ?? c.warn_item_qty_below_zero ?? true,
          blockItemQtyBelowZero: c.blockItemQtyBelowZero ?? c.block_item_qty_below_zero ?? false,
          warnItemCostZero: c.warnItemCostZero ?? c.warn_item_cost_zero ?? false,
          warnItemSellingBelowCost: c.warnItemSellingBelowCost ?? c.warn_item_selling_below_cost ?? false,
          displayInactiveItemsProcessing: c.displayInactiveItemsProcessing ?? c.display_inactive_items_processing ?? false,
          displayInactiveItemsReports: c.displayInactiveItemsReports ?? c.display_inactive_items_reports ?? false,
          salesOrdersReserveQty: c.salesOrdersReserveQty ?? c.sales_orders_reserve_qty ?? false,
          displayInactiveBundles: c.displayInactiveBundles ?? c.display_inactive_bundles ?? false,
          ageingMonthly: c.ageingMonthly ?? c.ageing_monthly ?? true,
          ageingBasedOn: c.ageingBasedOn ?? c.ageing_based_on ?? 'invoice_date',
          industry: c.industry ?? null,
          businessStructure: c.businessStructure ?? c.business_structure ?? null,
          socialFacebook: c.socialFacebook ?? c.social_facebook ?? null,
          socialLinkedin: c.socialLinkedin ?? c.social_linkedin ?? null,
          socialX: c.socialX ?? c.social_x ?? null,
        });
      }
    } catch {
      setError('Failed to load company');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDocuments = useCallback(async (companyId: string) => {
    try {
      const res = await apiFetch(`/api/accounting/company-documents?companyId=${companyId}`);
      const json = await res.json();
      if (json.data) setDocuments(json.data);
    } catch { /* supplementary */ }
  }, []);

  const fetchDocNumbers = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/company-settings?type=document-numbers');
      const json = await res.json();
      if (json.data) setDocNumbers(json.data);
    } catch { /* supplementary */ }
  }, []);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/company-settings?type=messages');
      const json = await res.json();
      if (json.data) {
        const map: Record<string, string> = {};
        for (const m of json.data as { messageType: string; message: string }[]) {
          map[m.messageType] = m.message;
        }
        setMessages(map);
      }
    } catch { /* supplementary */ }
  }, []);

  const fetchDimensionSettings = useCallback(async () => {
    try {
      const [ccRes, buRes] = await Promise.all([
        apiFetch('/api/accounting/accounting-settings?key=enable_cost_centres'),
        apiFetch('/api/accounting/accounting-settings?key=enable_business_units'),
      ]);
      const ccJson = await ccRes.json();
      const buJson = await buRes.json();
      setEnableCC(ccJson.data?.value === 'true');
      setEnableBU(buJson.data?.value === 'true');
      setDimLoaded(true);
    } catch { /* defaults to false */ setDimLoaded(true); }
  }, []);

  const fetchDocDisplayFields = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/accounting-settings?key=document_display_fields');
      const json = await res.json();
      if (json.data?.value) {
        const parsed = JSON.parse(json.data.value as string) as Record<string, boolean>;
        setDocDisplayFields(prev => ({ ...prev, ...parsed }));
      }
    } catch { /* keep defaults */ }
  }, []);

  useEffect(() => {
    if (activeCompany?.id) {
      void fetchCompany(activeCompany.id);
      void fetchDocuments(activeCompany.id);
      void fetchDocNumbers();
      void fetchMessages();
      void fetchDimensionSettings();
      void fetchDocDisplayFields();
    }
  }, [activeCompany?.id, fetchCompany, fetchDocuments, fetchDocNumbers, fetchMessages, fetchDimensionSettings, fetchDocDisplayFields]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!company) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // Save company settings
      const res = await apiFetch('/api/accounting/companies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(company),
      });
      if (!res.ok) throw new Error('Failed to save');

      // Save document numbers
      if (docNumbers.length > 0) {
        await apiFetch('/api/accounting/company-settings?type=document-numbers', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: docNumbers.map(d => ({
              documentType: d.documentType, prefix: d.prefix, nextNumber: d.nextNumber,
            })),
          }),
        });
      }

      // Save messages
      const msgArray = Object.entries(messages).map(([messageType, message]) => ({ messageType, message }));
      if (msgArray.length > 0) {
        await apiFetch('/api/accounting/company-settings?type=messages', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: msgArray }),
        });
      }

      // Save document display fields
      await apiFetch('/api/accounting/accounting-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'document_display_fields', value: JSON.stringify(docDisplayFields) }),
      });

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  const update = (field: keyof Company, value: unknown) => {
    if (!company) return;
    setCompany({ ...company, [field]: value } as Company);
  };

  const updateDocNum = (docType: string, field: 'prefix' | 'nextNumber', value: string | number) => {
    setDocNumbers(prev => prev.map(d => d.documentType === docType ? { ...d, [field]: value } : d));
  };

  const updateMsg = (key: string, value: string) => {
    setMessages(prev => ({ ...prev, [key]: value }));
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !company) return;
    if (file.size > 2 * 1024 * 1024) { setError('Logo must be under 2MB'); return; }
    setUploadingLogo(true);
    setError('');
    try {
      const logoData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await apiFetch('/api/accounting/company-logo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, logoData }),
      });
      if (!res.ok) throw new Error('Failed to upload logo');
      setCompany({ ...company, logoData });
    } catch {
      setError('Failed to upload logo');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!company) return;
    setUploadingLogo(true);
    try {
      const res = await apiFetch('/api/accounting/company-logo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, logoData: null }),
      });
      if (!res.ok) throw new Error('Failed to remove logo');
      setCompany({ ...company, logoData: null });
    } catch {
      setError('Failed to remove logo');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !company) return;
    if (file.size > 10 * 1024 * 1024) { setError('Document must be under 10MB'); return; }
    setUploadingDoc(true);
    setError('');
    try {
      const fileData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await apiFetch('/api/accounting/company-documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, documentType: docType, documentName: file.name, fileData, mimeType: file.type, fileSize: file.size }),
      });
      if (!res.ok) throw new Error('Failed to upload document');
      void fetchDocuments(company.id);
    } catch {
      setError('Failed to upload document');
    } finally {
      setUploadingDoc(false);
      e.target.value = '';
    }
  };

  const handleDocDownload = async (docId: string, docName: string) => {
    try {
      const res = await apiFetch(`/api/accounting/company-documents?id=${docId}&download=1`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = docName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { setError('Failed to download document'); }
  };

  const handleDocDelete = async (docId: string) => {
    if (!company || !window.confirm('Are you sure you want to delete this document?')) return;
    try {
      const res = await apiFetch(`/api/accounting/company-documents?id=${docId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      void fetchDocuments(company.id);
    } catch { setError('Failed to delete document'); }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><Building2 className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Company Settings</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Manage your company details and preferences</p>
            </div>
          </div>
          <button onClick={() => void handleSave()} disabled={saving || !company}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Changes
          </button>
        </div>

        {error && <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm"><AlertCircle className="h-4 w-4" /> {error}</div>}
        {saved && <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-3 flex items-center gap-2 text-teal-500 text-sm"><CheckCircle2 className="h-4 w-4" /> Changes saved successfully</div>}

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
        ) : company ? (
          <>
            {/* Tabs */}
            <div className="flex gap-1 overflow-x-auto border-b border-[var(--ff-border-primary)] pb-0">
              {TABS.map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? 'border-teal-500 text-teal-500'
                      : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                  }`}>
                  {tab.icon} {tab.label}
                </button>
              ))}
            </div>

            {/* Tab Content */}
            <div className="space-y-6">
              {activeTab === 'details' && renderDetailsTab()}
              {activeTab === 'general' && renderGeneralTab()}
              {activeTab === 'vat' && renderVatTab()}
              {activeTab === 'documents' && renderDocumentsTab()}
              {activeTab === 'branding' && renderBrandingTab()}
              {activeTab === 'dimensions' && renderDimensionsTab()}
            </div>
          </>
        ) : (
          <div className="text-center py-12 text-[var(--ff-text-secondary)]">No company configured</div>
        )}
      </div>
    </AppLayout>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TAB RENDERERS
  // ══════════════════════════════════════════════════════════════════════════

  function renderDetailsTab() {
    if (!company) return null;
    return (
      <>
        {/* Company Details */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Company Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={LABEL_CLS}>Company Name *</label><input className={INPUT_CLS} value={company.name} onChange={e => update('name', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Trading Name</label><input className={INPUT_CLS} value={company.tradingName || ''} onChange={e => update('tradingName', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Registered Name</label><input className={INPUT_CLS} value={company.registeredName || ''} onChange={e => update('registeredName', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Registration Number</label><input className={INPUT_CLS} value={company.registrationNumber || ''} onChange={e => update('registrationNumber', e.target.value)} /></div>
            <div>
              <label className={LABEL_CLS}>Entity Type</label>
              <select className={INPUT_CLS} value={company.entityType} onChange={e => update('entityType', e.target.value)}>
                {ENTITY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Industry</label>
              <select className={INPUT_CLS} value={company.industry || ''} onChange={e => update('industry', e.target.value || null)}>
                <option value="">Select industry...</option>
                {INDUSTRIES.map(ind => <option key={ind} value={ind}>{ind}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Business Structure</label>
              <select className={INPUT_CLS} value={company.businessStructure || ''} onChange={e => update('businessStructure', e.target.value || null)}>
                <option value="">Select structure...</option>
                {BUSINESS_STRUCTURES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div><label className={LABEL_CLS}>Contact Name</label><input className={INPUT_CLS} value={company.contactName || ''} onChange={e => update('contactName', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Email</label><input type="email" className={INPUT_CLS} value={company.email || ''} onChange={e => update('email', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Phone</label><input className={INPUT_CLS} value={company.phone || ''} onChange={e => update('phone', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Mobile</label><input className={INPUT_CLS} value={company.mobile || ''} onChange={e => update('mobile', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Fax</label><input className={INPUT_CLS} value={company.fax || ''} onChange={e => update('fax', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Website</label><input className={INPUT_CLS} value={company.website || ''} onChange={e => update('website', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Country</label><input className={INPUT_CLS} value={company.country || 'South Africa'} onChange={e => update('country', e.target.value)} /></div>
          </div>
          <div className="mt-4 space-y-1">
            <Toggle checked={company.emailUseForCommunication} onChange={v => update('emailUseForCommunication', v)} label="Use this Email for Communication" />
            <Toggle checked={company.emailAlwaysCc} onChange={v => update('emailAlwaysCc', v)} label="Always CC this Email Address" />
          </div>
        </section>

        {/* Postal Address */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Postal Address</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 1</label><input className={INPUT_CLS} value={company.addressLine1 || ''} onChange={e => update('addressLine1', e.target.value)} /></div>
            <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 2</label><input className={INPUT_CLS} value={company.addressLine2 || ''} onChange={e => update('addressLine2', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>City</label><input className={INPUT_CLS} value={company.city || ''} onChange={e => update('city', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Province</label><input className={INPUT_CLS} value={company.province || ''} onChange={e => update('province', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Postal Code</label><input className={INPUT_CLS} value={company.postalCode || ''} onChange={e => update('postalCode', e.target.value)} /></div>
          </div>
        </section>

        {/* Social Media */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Social Media Links</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={LABEL_CLS}>Facebook URL</label><input className={INPUT_CLS} value={company.socialFacebook || ''} onChange={e => update('socialFacebook', e.target.value || null)} placeholder="https://facebook.com/yourpage" /></div>
            <div><label className={LABEL_CLS}>LinkedIn URL</label><input className={INPUT_CLS} value={company.socialLinkedin || ''} onChange={e => update('socialLinkedin', e.target.value || null)} placeholder="https://linkedin.com/company/yourcompany" /></div>
            <div><label className={LABEL_CLS}>X (Twitter) URL</label><input className={INPUT_CLS} value={company.socialX || ''} onChange={e => update('socialX', e.target.value || null)} placeholder="https://x.com/yourhandle" /></div>
          </div>
        </section>

        {/* Physical Address */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Physical Address</h2>
          <label className="flex items-center gap-2 mb-4 cursor-pointer">
            <input
              type="checkbox"
              checked={physicalSameAsPostal}
              onChange={e => {
                const checked = e.target.checked;
                setPhysicalSameAsPostal(checked);
                if (checked) {
                  setCompany(prev => prev ? {
                    ...prev,
                    physicalAddressLine1: prev.addressLine1,
                    physicalAddressLine2: prev.addressLine2,
                    physicalCity: prev.city,
                    physicalProvince: prev.province,
                    physicalPostalCode: prev.postalCode,
                  } : prev);
                }
              }}
              className="h-4 w-4 accent-teal-500"
            />
            <span className="text-sm text-[var(--ff-text-secondary)]">Same as postal address</span>
          </label>
          {!physicalSameAsPostal && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 1</label><input className={INPUT_CLS} value={company.physicalAddressLine1 || ''} onChange={e => update('physicalAddressLine1', e.target.value)} /></div>
              <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 2</label><input className={INPUT_CLS} value={company.physicalAddressLine2 || ''} onChange={e => update('physicalAddressLine2', e.target.value)} /></div>
              <div><label className={LABEL_CLS}>City</label><input className={INPUT_CLS} value={company.physicalCity || ''} onChange={e => update('physicalCity', e.target.value)} /></div>
              <div><label className={LABEL_CLS}>Province</label><input className={INPUT_CLS} value={company.physicalProvince || ''} onChange={e => update('physicalProvince', e.target.value)} /></div>
              <div><label className={LABEL_CLS}>Postal Code</label><input className={INPUT_CLS} value={company.physicalPostalCode || ''} onChange={e => update('physicalPostalCode', e.target.value)} /></div>
            </div>
          )}
          {physicalSameAsPostal && (
            <p className="text-sm text-[var(--ff-text-tertiary)]">Physical address will mirror the postal address above.</p>
          )}
        </section>

        {/* Statutory Information */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Statutory Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={LABEL_CLS}>Income Tax Number</label><input className={INPUT_CLS} value={company.taxNumber || ''} onChange={e => update('taxNumber', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Tax Office</label><input className={INPUT_CLS} value={company.taxOffice || ''} onChange={e => update('taxOffice', e.target.value)} /></div>
          </div>
        </section>

        {/* Tax Practitioner */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Tax Practitioner Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={LABEL_CLS}>Practitioner Reg Number</label><input className={INPUT_CLS} value={company.taxPractitionerRegNumber || ''} onChange={e => update('taxPractitionerRegNumber', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Practitioner Name</label><input className={INPUT_CLS} value={company.taxPractitionerName || ''} onChange={e => update('taxPractitionerName', e.target.value)} /></div>
          </div>
        </section>

        {/* SARS Contact */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">SARS Company Contact Information</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={LABEL_CLS}>First Name</label><input className={INPUT_CLS} value={company.sarsContactFirstName || ''} onChange={e => update('sarsContactFirstName', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Last Name</label><input className={INPUT_CLS} value={company.sarsContactLastName || ''} onChange={e => update('sarsContactLastName', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Capacity</label><input className={INPUT_CLS} value={company.sarsContactCapacity || ''} onChange={e => update('sarsContactCapacity', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Contact Number</label><input className={INPUT_CLS} value={company.sarsContactNumber || ''} onChange={e => update('sarsContactNumber', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Telephone</label><input className={INPUT_CLS} value={company.sarsContactTelephone || ''} onChange={e => update('sarsContactTelephone', e.target.value)} /></div>
          </div>
        </section>

        {/* Banking */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Banking Details</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Used on invoices and statements for payment instructions</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div><label className={LABEL_CLS}>Bank Name</label><input className={INPUT_CLS} value={company.bankName || ''} onChange={e => update('bankName', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Account Number</label><input className={INPUT_CLS} value={company.bankAccountNumber || ''} onChange={e => update('bankAccountNumber', e.target.value)} /></div>
            <div><label className={LABEL_CLS}>Branch Code</label><input className={INPUT_CLS} value={company.bankBranchCode || ''} onChange={e => update('bankBranchCode', e.target.value)} /></div>
            <div>
              <label className={LABEL_CLS}>Account Type</label>
              <select className={INPUT_CLS} value={company.bankAccountType || ''} onChange={e => update('bankAccountType', e.target.value)}>
                <option value="">Select...</option>
                <option value="Current">Current</option>
                <option value="Savings">Savings</option>
                <option value="Transmission">Transmission</option>
                <option value="Credit Card">Credit Card</option>
              </select>
            </div>
          </div>
        </section>

        {/* Statutory Documents */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Statutory Documents</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Upload company registration certificates, tax clearance, and other statutory documents.</p>
          <div className="flex flex-col sm:flex-row items-start sm:items-end gap-3 mb-6">
            <div>
              <label className={LABEL_CLS}>Document Type</label>
              <select className={INPUT_CLS} value={docType} onChange={e => setDocType(e.target.value)}>
                {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer">
              {uploadingDoc ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload Document
              <input type="file" accept="image/*,application/pdf" className="hidden" onChange={handleDocUpload} disabled={uploadingDoc} />
            </label>
            <p className="text-xs text-[var(--ff-text-tertiary)]">Images or PDF. Max 10MB.</p>
          </div>
          {documents.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-primary)]">
                  <th className="pb-2 font-medium">Type</th><th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Uploaded</th><th className="pb-2 font-medium">Size</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr></thead>
                <tbody>
                  {documents.map(doc => (
                    <tr key={doc.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-3 text-[var(--ff-text-primary)]">{DOC_TYPE_LABELS[doc.documentType] || doc.documentType}</td>
                      <td className="py-3 text-[var(--ff-text-secondary)] flex items-center gap-2"><FileText className="h-4 w-4 text-[var(--ff-text-tertiary)]" />{doc.documentName}</td>
                      <td className="py-3 text-[var(--ff-text-secondary)]">{new Date(doc.createdAt).toLocaleDateString()}</td>
                      <td className="py-3 text-[var(--ff-text-secondary)]">{formatFileSize(doc.fileSize)}</td>
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => void handleDocDownload(doc.id, doc.documentName)} className="p-1.5 text-teal-500 hover:bg-teal-500/10 rounded-lg transition-colors" title="Download"><Download className="h-4 w-4" /></button>
                          <button onClick={() => void handleDocDelete(doc.id)} className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors" title="Delete"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-[var(--ff-text-tertiary)] text-center py-6">No documents uploaded yet.</p>}
        </section>
      </>
    );
  }

  function renderGeneralTab() {
    if (!company) return null;
    return (
      <>
        {/* Financial Year & Lockdown */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4 flex items-center gap-2"><Lock className="h-5 w-5" /> Financial Year & Lockdown</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className={LABEL_CLS}>Financial Year Start Month</label>
              <select className={INPUT_CLS} value={company.financialYearStart} onChange={e => update('financialYearStart', Number(e.target.value))}>
                {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL_CLS}>Default Currency</label>
              <select className={INPUT_CLS} value={company.defaultCurrency || 'ZAR'} onChange={e => update('defaultCurrency', e.target.value)}>
                <option value="ZAR">ZAR - South African Rand</option>
                <option value="USD">USD - US Dollar</option>
                <option value="EUR">EUR - Euro</option>
                <option value="GBP">GBP - British Pound</option>
              </select>
            </div>
          </div>
          <div className="border-t border-[var(--ff-border-primary)] pt-4">
            <Toggle checked={company.lockdownEnabled} onChange={v => update('lockdownEnabled', v)} label="Enable Lockdown Date" />
            <p className="text-xs text-[var(--ff-text-tertiary)] mt-1 mb-3">No transactions can be processed or edited with a date up to and including the lockdown date.</p>
            {company.lockdownEnabled && (
              <div className="max-w-xs">
                <label className={LABEL_CLS}>Lockdown Date</label>
                <input type="date" className={INPUT_CLS} value={company.lockdownDate || ''} onChange={e => update('lockdownDate', e.target.value)} />
              </div>
            )}
          </div>
        </section>

        {/* Regional Settings */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Regional Settings</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div><label className={LABEL_CLS}>Currency Symbol</label><input className={INPUT_CLS} value={company.currencySymbol} onChange={e => update('currencySymbol', e.target.value)} /></div>
            <div>
              <label className={LABEL_CLS}>Date Format</label>
              <select className={INPUT_CLS} value={company.dateFormat} onChange={e => update('dateFormat', e.target.value)}>
                <option value="dd/mm/yyyy">dd/mm/yyyy</option>
                <option value="mm/dd/yyyy">mm/dd/yyyy</option>
                <option value="yyyy-mm-dd">yyyy-mm-dd</option>
              </select>
            </div>
            <div><label className={LABEL_CLS}>Quantity Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.qtyDecimalPlaces} onChange={e => update('qtyDecimalPlaces', Number(e.target.value))} /></div>
            <div><label className={LABEL_CLS}>Value Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.valueDecimalPlaces} onChange={e => update('valueDecimalPlaces', Number(e.target.value))} /></div>
            <div><label className={LABEL_CLS}>Hours Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.hoursDecimalPlaces} onChange={e => update('hoursDecimalPlaces', Number(e.target.value))} /></div>
            <div><label className={LABEL_CLS}>Cost Price Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.costPriceDecimalPlaces} onChange={e => update('costPriceDecimalPlaces', Number(e.target.value))} /></div>
            <div><label className={LABEL_CLS}>Selling Price Decimal Places</label><input type="number" min="0" max="6" className={INPUT_CLS} value={company.sellingPriceDecimalPlaces} onChange={e => update('sellingPriceDecimalPlaces', Number(e.target.value))} /></div>
          </div>
        </section>

        {/* Rounding */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Rounding</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Set Accounting to round customer document values.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={LABEL_CLS}>Rounding Type</label>
              <select className={INPUT_CLS} value={company.roundingType} onChange={e => update('roundingType', e.target.value)}>
                <option value="none">No Rounding</option>
                <option value="up">Round Up</option>
                <option value="down">Round Down</option>
                <option value="nearest">Round to Nearest</option>
              </select>
            </div>
            {company.roundingType !== 'none' && (
              <div><label className={LABEL_CLS}>Round To Nearest</label><input type="number" step="0.01" className={INPUT_CLS} value={company.roundToNearest} onChange={e => update('roundToNearest', Number(e.target.value))} /></div>
            )}
          </div>
        </section>

        {/* Customer & Supplier Settings */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Customer & Supplier Settings</h2>
          <div className="space-y-1">
            <Toggle checked={company.warnDuplicateCustomerRef} onChange={v => update('warnDuplicateCustomerRef', v)} label="Warn when duplicate Customer Reference used on Customer Invoices" />
            <Toggle checked={company.warnDuplicateSupplierInv} onChange={v => update('warnDuplicateSupplierInv', v)} label="Warn when duplicate Supplier Invoice number used on Supplier Invoices" />
            <Toggle checked={company.displayInactiveCustomersProcessing} onChange={v => update('displayInactiveCustomersProcessing', v)} label="Display inactive Customers for selection when processing" />
            <Toggle checked={company.displayInactiveSuppliersProcessing} onChange={v => update('displayInactiveSuppliersProcessing', v)} label="Display inactive Suppliers for selection when processing" />
            <Toggle checked={company.displayInactiveCustomersReports} onChange={v => update('displayInactiveCustomersReports', v)} label="Display inactive Customers for selection on reports" />
            <Toggle checked={company.displayInactiveSuppliersReports} onChange={v => update('displayInactiveSuppliersReports', v)} label="Display inactive Suppliers for selection on reports" />
            <Toggle checked={company.useInclusiveProcessing} onChange={v => update('useInclusiveProcessing', v)} label="Use inclusive processing on customer/supplier documents by default" />
            <Toggle checked={company.useAccountDefaultLineType} onChange={v => update('useAccountDefaultLineType', v)} label="Use Account as default document line type selection" />
          </div>
        </section>

        {/* Item Settings */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Item Settings</h2>
          <div className="space-y-1">
            <Toggle checked={company.warnItemQtyBelowZero} onChange={v => update('warnItemQtyBelowZero', v)} label="Warn when Item quantities fall below zero" />
            <Toggle checked={company.blockItemQtyBelowZero} onChange={v => update('blockItemQtyBelowZero', v)} label="Do not allow Item quantities below zero" />
            <Toggle checked={company.warnItemCostZero} onChange={v => update('warnItemCostZero', v)} label="Warn when Item cost is zero" />
            <Toggle checked={company.warnItemSellingBelowCost} onChange={v => update('warnItemSellingBelowCost', v)} label="Warn when Item selling price is below cost" />
            <Toggle checked={company.displayInactiveItemsProcessing} onChange={v => update('displayInactiveItemsProcessing', v)} label="Display inactive Items for selection on document lines" />
            <Toggle checked={company.displayInactiveItemsReports} onChange={v => update('displayInactiveItemsReports', v)} label="Display inactive Items for selection on reports" />
            <Toggle checked={company.salesOrdersReserveQty} onChange={v => update('salesOrdersReserveQty', v)} label="Sales Orders Reserve Item Quantities" />
            <Toggle checked={company.displayInactiveBundles} onChange={v => update('displayInactiveBundles', v)} label="Display inactive Item Bundles for selection on document lines" />
          </div>
        </section>

        {/* Outstanding Balances */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Outstanding Balances</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Ageing refers to the number of days that a Customer or Supplier balance is outstanding.</p>
          <div className="space-y-3">
            <Toggle checked={company.ageingMonthly} onChange={v => update('ageingMonthly', v)} label="Use Monthly ageing (display unpaid invoices by calendar month)" />
            <div className="max-w-xs">
              <label className={LABEL_CLS}>Run Ageing Based On</label>
              <select className={INPUT_CLS} value={company.ageingBasedOn} onChange={e => update('ageingBasedOn', e.target.value)}>
                <option value="invoice_date">Invoice Date</option>
                <option value="due_date">Due Date</option>
              </select>
            </div>
          </div>
        </section>
      </>
    );
  }

  function renderVatTab() {
    if (!company) return null;
    return (
      <>
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">VAT System</h2>
          <div className="space-y-3">
            {[
              { value: 'invoice', label: 'Invoice Based', desc: 'VAT is accounted for when invoices are issued/received' },
              { value: 'payment', label: 'Payment Based', desc: 'VAT is accounted for when payments are made/received' },
              { value: 'none', label: 'No VAT', desc: 'Company is not registered for VAT' },
            ].map(opt => (
              <label key={opt.value} className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-[var(--ff-border-primary)] hover:border-teal-500/50 transition-colors">
                <input type="radio" name="vatSystem" value={opt.value} checked={company.vatSystemType === opt.value}
                  onChange={e => update('vatSystemType', e.target.value)}
                  className="mt-0.5 accent-teal-500" />
                <div>
                  <div className="text-sm font-medium text-[var(--ff-text-primary)]">{opt.label}</div>
                  <div className="text-xs text-[var(--ff-text-tertiary)]">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </section>

        {company.vatSystemType !== 'none' && (
          <section className={SECTION_CLS}>
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">VAT Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div><label className={LABEL_CLS}>VAT Number</label><input className={INPUT_CLS} value={company.vatNumber || ''} onChange={e => update('vatNumber', e.target.value)} placeholder="e.g. 4123456789" /></div>
              <div>
                <label className={LABEL_CLS}>VAT Reporting Frequency</label>
                <select className={INPUT_CLS} value={company.vatPeriod} onChange={e => update('vatPeriod', e.target.value)}>
                  <option value="monthly">Monthly</option>
                  <option value="bi-monthly">Bi-Monthly</option>
                </select>
              </div>
              {company.vatPeriod === 'bi-monthly' && (
                <div>
                  <label className={LABEL_CLS}>Bi-Monthly Period Alignment</label>
                  <select className={INPUT_CLS} value={company.vatPeriodAlignment || 'odd'} onChange={e => update('vatPeriodAlignment', e.target.value)}>
                    <option value="odd">Odd months (Jan-Feb, Mar-Apr, May-Jun...)</option>
                    <option value="even">Even months (Feb-Mar, Apr-May, Jun-Jul...)</option>
                  </select>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                    {company.vatPeriodAlignment === 'even'
                      ? 'Category B: periods start in even months (Feb, Apr, Jun, Aug, Oct, Dec)'
                      : 'Category A: periods start in odd months (Jan, Mar, May, Jul, Sep, Nov)'}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}
      </>
    );
  }

  function renderDocumentsTab() {
    return (
      <>
        {/* Document Numbers */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4 flex items-center gap-2"><FileDigit className="h-5 w-5" /> Document Numbers</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Configure the prefix and next number for each document type.</p>
          {docNumbers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-primary)]">
                  <th className="pb-2 font-medium">Document Type</th>
                  <th className="pb-2 font-medium">Prefix</th>
                  <th className="pb-2 font-medium">Next Number</th>
                  <th className="pb-2 font-medium">Preview</th>
                </tr></thead>
                <tbody>
                  {docNumbers.map(d => (
                    <tr key={d.documentType} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-2 text-[var(--ff-text-primary)]">{DOC_NUMBER_LABELS[d.documentType] || d.documentType}</td>
                      <td className="py-2"><input className={`${INPUT_CLS} max-w-[100px]`} value={d.prefix} onChange={e => updateDocNum(d.documentType, 'prefix', e.target.value)} /></td>
                      <td className="py-2"><input type="number" min="1" className={`${INPUT_CLS} max-w-[120px]`} value={d.nextNumber} onChange={e => updateDocNum(d.documentType, 'nextNumber', Number(e.target.value))} /></td>
                      <td className="py-2 text-[var(--ff-text-tertiary)] font-mono text-xs">{d.prefix}{String(d.nextNumber).padStart(d.padding, '0')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-sm text-[var(--ff-text-tertiary)] text-center py-4">Loading document numbers...</p>}
        </section>

        {/* Statement Messages */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Statement Messages</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Messages that print on customer statements based on the oldest outstanding balance.</p>
          <div className="space-y-3">
            {STATEMENT_MSG_TYPES.map(m => (
              <div key={m.key}>
                <label className={LABEL_CLS}>{m.label}</label>
                <input className={INPUT_CLS} value={messages[m.key] || ''} onChange={e => updateMsg(m.key, e.target.value)} placeholder={`Message for ${m.label.toLowerCase()} balances...`} />
              </div>
            ))}
          </div>
        </section>

        {/* Customer Document Messages */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Customer Document Messages</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Default message that prints on each document type. Can be changed per document.</p>
          <div className="space-y-3">
            {CUSTOMER_MSG_TYPES.map(m => (
              <div key={m.key}>
                <label className={LABEL_CLS}>{m.label}</label>
                <textarea className={INPUT_CLS} rows={2} value={messages[m.key] || ''} onChange={e => updateMsg(m.key, e.target.value)} placeholder={`Default message for ${m.label.toLowerCase()}...`} />
              </div>
            ))}
          </div>
        </section>

        {/* Supplier Document Messages */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Supplier Document Messages</h2>
          <div className="space-y-3">
            {SUPPLIER_MSG_TYPES.map(m => (
              <div key={m.key}>
                <label className={LABEL_CLS}>{m.label}</label>
                <textarea className={INPUT_CLS} rows={2} value={messages[m.key] || ''} onChange={e => updateMsg(m.key, e.target.value)} placeholder={`Default message for ${m.label.toLowerCase()}...`} />
              </div>
            ))}
          </div>
        </section>

        {/* Information displayed on documents */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Information displayed on documents</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Choose which company details appear on generated invoices, statements, and other documents.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {([
              { key: 'registrationNumber', label: 'Registration Number' },
              { key: 'vatNumber', label: 'VAT Number' },
              { key: 'companyDirectors', label: 'Company Directors' },
              { key: 'physicalAddress', label: 'Physical Address' },
              { key: 'phoneNumber', label: 'Phone Number' },
              { key: 'emailAddress', label: 'Email Address' },
              { key: 'website', label: 'Website' },
              { key: 'socialMediaLinks', label: 'Social Media Links' },
            ] as { key: string; label: string }[]).map(field => (
              <label key={field.key} className="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] transition-colors">
                <input
                  type="checkbox"
                  checked={docDisplayFields[field.key] ?? false}
                  onChange={e => setDocDisplayFields(prev => ({ ...prev, [field.key]: e.target.checked }))}
                  className="h-4 w-4 accent-teal-500"
                />
                <span className="text-sm text-[var(--ff-text-primary)]">{field.label}</span>
              </label>
            ))}
          </div>
        </section>
      </>
    );
  }

  async function saveDimensionSetting(key: string, value: boolean) {
    try {
      await apiFetch('/api/accounting/accounting-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: String(value) }),
      });
    } catch { /* ignore */ }
  }

  function renderDimensionsTab() {
    return (
      <>
        <div className={SECTION_CLS}>
          <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Reporting Dimensions</h3>
          <p className="text-sm text-[var(--ff-text-secondary)] mb-6">
            Enable cost centre and business unit tracking to tag transactions and filter reports by these dimensions.
          </p>

          {!dimLoaded ? (
            <div className="flex items-center gap-2 text-[var(--ff-text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading...</div>
          ) : (
            <div className="space-y-6">
              {/* Cost Centres */}
              <div className="flex items-start justify-between gap-4 p-4 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]">
                <div>
                  <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">Cost Centre Tracking (CC1 & CC2)</h4>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                    CC1 is typically used for client or division-level tracking. CC2 for project or sub-division.
                    Shows CC1 and CC2 columns on bank transactions, journal entries, and enables filtering on reports.
                  </p>
                  {enableCC && (
                    <a href="/accounting/cost-centres" className="text-xs text-blue-400 hover:text-blue-300 mt-2 inline-block">
                      Manage Cost Centres →
                    </a>
                  )}
                </div>
                <Toggle
                  checked={enableCC}
                  onChange={(v) => { setEnableCC(v); void saveDimensionSetting('enable_cost_centres', v); }}
                  label=""
                />
              </div>

              {/* Business Units */}
              <div className="flex items-start justify-between gap-4 p-4 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)]">
                <div>
                  <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">Business Unit Tracking</h4>
                  <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">
                    Tag transactions by department or business unit. Shows a BU column on bank transactions and journal entries,
                    and enables BU filtering on financial reports.
                  </p>
                  {enableBU && (
                    <a href="/accounting/business-units" className="text-xs text-blue-400 hover:text-blue-300 mt-2 inline-block">
                      Manage Business Units →
                    </a>
                  )}
                </div>
                <Toggle
                  checked={enableBU}
                  onChange={(v) => { setEnableBU(v); void saveDimensionSetting('enable_business_units', v); }}
                  label=""
                />
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  function renderBrandingTab() {
    if (!company) return null;
    return (
      <>
        {/* Company Logo */}
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Company Logo</h2>
          <div className="flex items-center gap-6 mb-6">
            {company.logoData ? (
              <img src={company.logoData} className="h-20 w-20 object-contain rounded-lg border border-gray-700" alt="Company logo" />
            ) : (
              <div className="h-20 w-20 rounded-lg border border-dashed border-[var(--ff-border-primary)] flex items-center justify-center">
                <Building2 className="h-8 w-8 text-[var(--ff-text-tertiary)]" />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors cursor-pointer">
                {uploadingLogo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload Logo
                <input type="file" accept="image/jpeg,image/png,image/webp,.gif,.bmp,.tiff" className="hidden" onChange={handleLogoUpload} disabled={uploadingLogo} />
              </label>
              {company.logoData && (
                <button onClick={() => void handleRemoveLogo()} disabled={uploadingLogo} className="flex items-center gap-2 px-4 py-2 text-red-500 hover:bg-red-500/10 rounded-lg text-sm font-medium transition-colors">
                  <Trash2 className="h-4 w-4" /> Remove Logo
                </button>
              )}
              <p className="text-xs text-[var(--ff-text-tertiary)]">JPEG, PNG, WebP, GIF, BMP, TIFF. Max 2MB.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={LABEL_CLS}>Position of Logo on Invoices and Statements</label>
              <select className={INPUT_CLS} value={company.logoPosition} onChange={e => update('logoPosition', e.target.value)}>
                <option value="top-left">Top Left</option>
                <option value="top-center">Top Center</option>
                <option value="top-right">Top Right</option>
              </select>
            </div>
          </div>

          <div className="mt-4 space-y-1">
            <Toggle checked={company.logoOnEmails} onChange={v => update('logoOnEmails', v)} label="Show Logo on Invoice and Statement Emails" />
            <Toggle checked={company.logoOnPortal} onChange={v => update('logoOnPortal', v)} label="Show Logo on Customer Portal" />
          </div>
        </section>
      </>
    );
  }
}
