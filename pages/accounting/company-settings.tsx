/**
 * Company Settings — shell page
 * Loads shared company data; delegates rendering to per-tab components.
 * Layout: sticky left sidebar (grouped categories) + scrollable content area.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Save, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
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
import { DimensionSettings } from '@/components/accounting/settings/DimensionSettings';
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

  // Documents (statutory files)
  const [documents, setDocuments] = useState<CompanyDocument[]>([]);

  // Document numbers & messages (Documents tab)
  const [docNumbers, setDocNumbers] = useState<DocumentNumber[]>([]);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [dispLoadFailed, setDispLoadFailed] = useState(false);
  const [docDisplayFields, setDocDisplayFields] = useState<Record<string, boolean>>({
    registrationNumber: true, vatNumber: true, companyDirectors: false,
    physicalAddress: false, phoneNumber: true, emailAddress: true, website: false, socialMediaLinks: false,
  });

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchCompany = useCallback(async (companyId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/companies?id=${companyId}`);
      await assertOk(res, 'Could not load company - try again');
      const json = await res.json();
      const c = json.data;
      if (c) setCompany(mapApiCompany(c as Record<string, unknown>));
    } catch (err) {
      setCompany(null);
      setError(apiErrorMessage(err, 'Could not load company - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSupplementary = useCallback(async (companyId: string) => {
    const get = async (url: string) => {
      const r = await apiFetch(url);
      await assertOk(r, 'Could not load some company settings - try again');
      return r.json();
    };
    const [docsRes, numRes, msgRes, dispRes] = await Promise.allSettled([
      get(`/api/accounting/company-documents?companyId=${companyId}`),
      get('/api/accounting/company-settings?type=document-numbers'),
      get('/api/accounting/company-settings?type=messages'),
      get('/api/accounting/accounting-settings?key=document_display_fields'),
    ]);
    const failed = [docsRes, numRes, msgRes, dispRes].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) setError(apiErrorMessage(failed.reason, 'Could not load some company settings - try again'));
    if (docsRes.status === 'rejected') setDocuments([]);
    if (numRes.status === 'rejected') setDocNumbers([]);
    if (msgRes.status === 'rejected') setMessages({});
    setDispLoadFailed(dispRes.status === 'rejected'); // never write the default display fields over unread real ones
    if (docsRes.status === 'fulfilled' && docsRes.value.data) setDocuments(docsRes.value.data as CompanyDocument[]);
    if (numRes.status === 'fulfilled' && numRes.value.data) setDocNumbers(numRes.value.data as DocumentNumber[]);
    if (msgRes.status === 'fulfilled' && msgRes.value.data) {
      const map: Record<string, string> = {};
      for (const m of msgRes.value.data as { messageType: string; message: string }[]) map[m.messageType] = m.message;
      setMessages(map);
    }
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
      const put = async (url: string, body: unknown, fallback: string) => {
        const r = await apiFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        await assertOk(r, fallback);
      };
      await put('/api/accounting/companies', company, 'Could not save the company details - try again');
      const after = 'Company details saved, but some settings could not be saved - try again';
      await Promise.all([
        docNumbers.length > 0 && put('/api/accounting/company-settings?type=document-numbers',
          { updates: docNumbers.map(d => ({ documentType: d.documentType, prefix: d.prefix, nextNumber: d.nextNumber })) }, after),
        Object.keys(messages).length > 0 && put('/api/accounting/company-settings?type=messages',
          { messages: Object.entries(messages).map(([messageType, message]) => ({ messageType, message })) }, after),
        !dispLoadFailed && put('/api/accounting/accounting-settings', { key: 'document_display_fields', value: JSON.stringify(docDisplayFields) }, after),
      ].filter(Boolean));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the changes - try again'));
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
        return null; // Kept mounted below so pending saves survive tab navigation.
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
            className="flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
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

        {loading && (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        )}
        <div hidden={loading || !company}>
          {/*
           * Layout:
           *   mobile  → flex-col: the mobile nav strip (inside SettingsSidebar,
           *             md:hidden) stacks above the content area
           *   desktop → flex-row: sticky sidebar (240 px) left, content (flex-1) right
           */}
          <div className="flex flex-col md:flex-row gap-6 items-start">
            <SettingsSidebar activeTab={activeTab} onTabChange={setActiveTab} />
            <div className="flex-1 min-w-0 space-y-6">
              {renderContent()}
              <div hidden={activeTab !== 'dimensions'}>
                {activeCompany?.id && <DimensionSettings key={activeCompany.id} />}
              </div>
            </div>
          </div>
        </div>
        {!loading && !company && (
          <div className="text-center py-12 text-[var(--ff-text-secondary)]">No company configured</div>
        )}
      </div>
    </AppLayout>
  );
}
