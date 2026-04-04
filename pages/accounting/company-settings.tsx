/**
 * Company Settings — shell page
 * Loads shared company data; delegates rendering to per-tab components.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Save, Loader2, AlertCircle, CheckCircle2, Settings2, Receipt, FileDigit, Palette, Layers } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { Company, DocumentNumber, CompanyDocument } from '@/components/accounting/settings/settingsTypes';
import { DetailsTab } from '@/components/accounting/settings/DetailsTab';
import { GeneralTab } from '@/components/accounting/settings/GeneralTab';
import { VatTab } from '@/components/accounting/settings/VatTab';
import { DocumentsTab } from '@/components/accounting/settings/DocumentsTab';
import { BrandingTab } from '@/components/accounting/settings/BrandingTab';
import { DimensionsTab } from '@/components/accounting/settings/DimensionsTab';

type TabId = 'details' | 'general' | 'vat' | 'documents' | 'branding' | 'dimensions';

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: 'details', label: 'Company Details', icon: <Building2 className="h-4 w-4" /> },
  { id: 'general', label: 'General Settings', icon: <Settings2 className="h-4 w-4" /> },
  { id: 'vat', label: 'VAT Settings', icon: <Receipt className="h-4 w-4" /> },
  { id: 'documents', label: 'Documents & Statements', icon: <FileDigit className="h-4 w-4" /> },
  { id: 'branding', label: 'Branding', icon: <Palette className="h-4 w-4" /> },
  { id: 'dimensions', label: 'Dimensions', icon: <Layers className="h-4 w-4" /> },
];

export default function CompanySettingsPage() {
  const { activeCompany } = useCompany();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('details');

  // Dimensions
  const [enableCC, setEnableCC] = useState(false);
  const [enableBU, setEnableBU] = useState(false);
  const [dimLoaded, setDimLoaded] = useState(false);

  // Documents (statutory files)
  const [documents, setDocuments] = useState<CompanyDocument[]>([]);

  // Document numbers & messages (Documents tab)
  const [docNumbers, setDocNumbers] = useState<DocumentNumber[]>([]);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [docDisplayFields, setDocDisplayFields] = useState<Record<string, boolean>>({
    registrationNumber: true, vatNumber: true, companyDirectors: false,
    physicalAddress: false, phoneNumber: true, emailAddress: true, website: false, socialMediaLinks: false,
  });

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchCompany = useCallback(async (companyId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/companies?id=${companyId}`);
      const json = await res.json();
      const c = json.data;
      if (c) {
        setCompany({
          id: c.id, name: c.name,
          tradingName: c.tradingName ?? c.trading_name ?? null,
          registrationNumber: c.registrationNumber ?? c.registration_number ?? null,
          vatNumber: c.vatNumber ?? c.vat_number ?? null,
          taxNumber: c.taxNumber ?? c.tax_number ?? null,
          addressLine1: c.addressLine1 ?? c.address_line1 ?? null,
          addressLine2: c.addressLine2 ?? c.address_line2 ?? null,
          city: c.city ?? null, province: c.province ?? null,
          postalCode: c.postalCode ?? c.postal_code ?? null,
          phone: c.phone ?? null, email: c.email ?? null,
          website: c.website ?? null, country: c.country ?? 'South Africa',
          logoData: c.logoData ?? c.logo_data ?? null,
          bankName: c.bankName ?? c.bank_name ?? null,
          bankAccountNumber: c.bankAccountNumber ?? c.bank_account_number ?? null,
          bankBranchCode: c.bankBranchCode ?? c.bank_branch_code ?? null,
          bankAccountType: c.bankAccountType ?? c.bank_account_type ?? null,
          financialYearStart: c.financialYearStart ?? c.financial_year_start ?? 3,
          vatPeriod: c.vatPeriod ?? c.vat_period ?? 'bi-monthly',
          vatPeriodAlignment: c.vatPeriodAlignment ?? c.vat_period_alignment ?? 'odd',
          defaultCurrency: c.defaultCurrency ?? c.default_currency ?? 'ZAR',
          lockdownEnabled: c.lockdownEnabled ?? c.lockdown_enabled ?? false,
          lockdownDate: c.lockdownDate ?? c.lockdown_date ?? null,
          vatSystemType: c.vatSystemType ?? c.vat_system_type ?? 'invoice',
          entityType: c.entityType ?? c.entity_type ?? 'company',
          registeredName: c.registeredName ?? c.registered_name ?? null,
          taxOffice: c.taxOffice ?? c.tax_office ?? null,
          contactName: c.contactName ?? c.contact_name ?? null,
          fax: c.fax ?? null, mobile: c.mobile ?? null,
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

  const fetchSupplementary = useCallback(async (companyId: string) => {
    const [docsRes, numRes, msgRes, ccRes, buRes, dispRes] = await Promise.allSettled([
      apiFetch(`/api/accounting/company-documents?companyId=${companyId}`).then(r => r.json()),
      apiFetch('/api/accounting/company-settings?type=document-numbers').then(r => r.json()),
      apiFetch('/api/accounting/company-settings?type=messages').then(r => r.json()),
      apiFetch('/api/accounting/accounting-settings?key=enable_cost_centres').then(r => r.json()),
      apiFetch('/api/accounting/accounting-settings?key=enable_business_units').then(r => r.json()),
      apiFetch('/api/accounting/accounting-settings?key=document_display_fields').then(r => r.json()),
    ]);
    if (docsRes.status === 'fulfilled' && docsRes.value.data) setDocuments(docsRes.value.data as CompanyDocument[]);
    if (numRes.status === 'fulfilled' && numRes.value.data) setDocNumbers(numRes.value.data as DocumentNumber[]);
    if (msgRes.status === 'fulfilled' && msgRes.value.data) {
      const map: Record<string, string> = {};
      for (const m of msgRes.value.data as { messageType: string; message: string }[]) map[m.messageType] = m.message;
      setMessages(map);
    }
    setEnableCC(ccRes.status === 'fulfilled' && ccRes.value.data?.value === 'true');
    setEnableBU(buRes.status === 'fulfilled' && buRes.value.data?.value === 'true');
    setDimLoaded(true);
    if (dispRes.status === 'fulfilled' && dispRes.value.data?.value) {
      try { setDocDisplayFields(prev => ({ ...prev, ...(JSON.parse(dispRes.value.data.value as string) as Record<string, boolean>) })); } catch { /* keep defaults */ }
    }
  }, []);

  useEffect(() => {
    if (activeCompany?.id) {
      void fetchCompany(activeCompany.id);
      void fetchSupplementary(activeCompany.id);
    }
  }, [activeCompany?.id, fetchCompany, fetchSupplementary]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const update = (field: keyof Company, value: unknown) => {
    setCompany(prev => prev ? { ...prev, [field]: value } as Company : prev);
  };

  const handleSave = async () => {
    if (!company) return;
    setSaving(true); setError(''); setSaved(false);
    try {
      const res = await apiFetch('/api/accounting/companies', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(company),
      });
      if (!res.ok) throw new Error('Failed to save');
      await Promise.all([
        docNumbers.length > 0 && apiFetch('/api/accounting/company-settings?type=document-numbers', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: docNumbers.map(d => ({ documentType: d.documentType, prefix: d.prefix, nextNumber: d.nextNumber })) }),
        }),
        Object.keys(messages).length > 0 && apiFetch('/api/accounting/company-settings?type=messages', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: Object.entries(messages).map(([messageType, message]) => ({ messageType, message })) }),
        }),
        apiFetch('/api/accounting/accounting-settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'document_display_fields', value: JSON.stringify(docDisplayFields) }),
        }),
      ].filter(Boolean));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

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
            {/* Tab bar */}
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

            {/* Tab content */}
            <div className="space-y-6">
              {activeTab === 'details' && (
                <DetailsTab
                  company={company} onChange={update} onCompanyChange={setCompany}
                  documents={documents} onDocumentsChange={setDocuments} onError={setError}
                />
              )}
              {activeTab === 'general' && <GeneralTab company={company} onChange={update} />}
              {activeTab === 'vat' && <VatTab company={company} onChange={update} />}
              {activeTab === 'documents' && (
                <DocumentsTab
                  docNumbers={docNumbers} messages={messages} docDisplayFields={docDisplayFields}
                  onDocNumChange={(dt, f, v) => setDocNumbers(prev => prev.map(d => d.documentType === dt ? { ...d, [f]: v } : d))}
                  onMessageChange={(k, v) => setMessages(prev => ({ ...prev, [k]: v }))}
                  onDisplayFieldChange={(k, v) => setDocDisplayFields(prev => ({ ...prev, [k]: v }))}
                />
              )}
              {activeTab === 'branding' && (
                <BrandingTab company={company} onChange={update} onCompanyChange={setCompany} onError={setError} />
              )}
              {activeTab === 'dimensions' && (
                <DimensionsTab enableCC={enableCC} enableBU={enableBU} dimLoaded={dimLoaded} onCCChange={setEnableCC} onBUChange={setEnableBU} />
              )}
            </div>
          </>
        ) : (
          <div className="text-center py-12 text-[var(--ff-text-secondary)]">No company configured</div>
        )}
      </div>
    </AppLayout>
  );
}
