/**
 * Company Settings — shell page
 * Loads shared company data; delegates rendering to per-tab components.
 * Layout: sticky left sidebar (grouped categories) + scrollable content area.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Save, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { Company, DocumentNumber, CompanyDocument } from '@/components/accounting/settings/settingsTypes';
import { mapApiCompany } from '@/components/accounting/settings/mapApiCompany';
import { SettingsSidebar } from '@/components/accounting/settings/SettingsSidebar';
import { parseTabId, type TabId } from '@/components/accounting/settings/settingsNav';
import { DetailsTab } from '@/components/accounting/settings/DetailsTab';
import { GeneralTab } from '@/components/accounting/settings/GeneralTab';
import { VatTab } from '@/components/accounting/settings/VatTab';
import { ComplianceTab } from '@/components/accounting/settings/ComplianceTab';
import { DocumentsTab } from '@/components/accounting/settings/DocumentsTab';
import { BrandingTab } from '@/components/accounting/settings/BrandingTab';
import { DimensionsTab } from '@/components/accounting/settings/DimensionsTab';
import { AgingTab } from '@/components/accounting/settings/AgingTab';
import { DocMessagesTab } from '@/components/accounting/settings/DocMessagesTab';
import { EmailTemplatesTab } from '@/components/accounting/settings/EmailTemplatesTab';
import { UdfTab } from '@/components/accounting/settings/UdfTab';
import { RegionalTab } from '@/components/accounting/settings/RegionalTab';
import { CustomerZoneTab } from '@/components/accounting/settings/CustomerZoneTab';
import { NetcashTab } from '@/components/accounting/settings/NetcashTab';

export default function CompanySettingsPage() {
  const { activeCompany, loading: companiesLoading } = useCompany();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('details');

  // Deep links land on the tab they name (e.g. the "not registered for VAT"
  // notice links to ?tab=vat). Query params are only available after hydration,
  // so this runs as an effect rather than in the useState initialiser.
  const router = useRouter();
  useEffect(() => {
    const tab = parseTabId(router.query.tab);
    if (tab) setActiveTab(tab);
  }, [router.query.tab]);

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
      if (c) setCompany(mapApiCompany(c as Record<string, unknown>));
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
    } else if (!companiesLoading) {
      // Company context finished loading but no active company — stop spinning
      setLoading(false);
    }
  }, [activeCompany?.id, companiesLoading, fetchCompany, fetchSupplementary]);

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

  // ── Tab content renderer ──────────────────────────────────────────────────

  const renderContent = () => {
    if (!company) return null;
    switch (activeTab) {
      case 'details':
        return (
          <DetailsTab
            company={company} onChange={update} onCompanyChange={setCompany}
            documents={documents} onDocumentsChange={setDocuments} onError={setError}
          />
        );
      case 'general':
        return <GeneralTab company={company} onChange={update} />;
      case 'vat':
        return <VatTab company={company} onChange={update} />;
      case 'compliance':
        return <ComplianceTab />;
      case 'documents':
        return (
          <DocumentsTab
            docNumbers={docNumbers} messages={messages} docDisplayFields={docDisplayFields}
            onDocNumChange={(dt, f, v) => setDocNumbers(prev => prev.map(d => d.documentType === dt ? { ...d, [f]: v } : d))}
            onMessageChange={(k, v) => setMessages(prev => ({ ...prev, [k]: v }))}
            onDisplayFieldChange={(k, v) => setDocDisplayFields(prev => ({ ...prev, [k]: v }))}
          />
        );
      case 'aging':
        return <AgingTab company={company} onChange={update} />;
      case 'doc-messages':
        return (
          <DocMessagesTab
            messages={messages}
            onMessageChange={(k, v) => setMessages(prev => ({ ...prev, [k]: v }))}
          />
        );
      case 'email-templates':
        return <EmailTemplatesTab company={company} onChange={update} />;
      case 'branding':
        return <BrandingTab company={company} onChange={update} onCompanyChange={setCompany} onError={setError} />;
      case 'customer-zone':
        return <CustomerZoneTab company={company} onChange={update} />;
      case 'dimensions':
        return (
          <DimensionsTab
            enableCC={enableCC} enableBU={enableBU} dimLoaded={dimLoaded}
            onCCChange={setEnableCC} onBUChange={setEnableBU}
          />
        );
      case 'udf':
        return <UdfTab />;
      case 'regional':
        return <RegionalTab company={company} onChange={update} />;
      case 'netcash':
        return <NetcashTab company={company} onChange={update} />;
      default:
        return null;
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Building2 className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Company Settings</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Manage your company details and preferences</p>
            </div>
          </div>
          <button
            onClick={() => void handleSave()}
            disabled={saving || !company}
            className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Changes
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {saved && (
          <div className="bg-teal-500/10 border border-teal-500/30 rounded-lg p-3 flex items-center gap-2 text-teal-500 text-sm">
            <CheckCircle2 className="h-4 w-4" /> Changes saved successfully
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        ) : company ? (
          /*
           * Layout:
           *   mobile  → flex-col: the mobile nav strip (inside SettingsSidebar,
           *             md:hidden) stacks above the content area
           *   desktop → flex-row: sticky sidebar (240 px) left, content (flex-1) right
           */
          <div className="flex flex-col md:flex-row gap-6 items-start">
            <SettingsSidebar activeTab={activeTab} onTabChange={setActiveTab} />
            <div className="flex-1 min-w-0 space-y-6">
              {renderContent()}
            </div>
          </div>
        ) : (
          <div className="text-center py-12 text-[var(--ff-text-secondary)]">No company configured</div>
        )}
      </div>
    </AppLayout>
  );
}
