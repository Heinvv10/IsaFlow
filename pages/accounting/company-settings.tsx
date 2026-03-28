/**
 * Company Settings — Manage company details, branding, banking
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Building2, Save, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';

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
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranchCode: string | null;
  financialYearStart: number;
  vatPeriod: string;
}

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none';
const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

export default function CompanySettingsPage() {
  const { activeCompany } = useCompany();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

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
          bankName: c.bankName ?? c.bank_name ?? null,
          bankAccountNumber: c.bankAccountNumber ?? c.bank_account_number ?? null,
          bankBranchCode: c.bankBranchCode ?? c.bank_branch_code ?? null,
          financialYearStart: c.financialYearStart ?? c.financial_year_start ?? 3,
          vatPeriod: c.vatPeriod ?? c.vat_period ?? 'bi-monthly',
        });
      }
    } catch {
      setError('Failed to load company');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeCompany?.id) void fetchCompany(activeCompany.id);
  }, [activeCompany?.id, fetchCompany]);

  const handleSave = async () => {
    if (!company) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await apiFetch('/api/accounting/companies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(company),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  const update = (field: keyof Company, value: string | number) => {
    if (!company) return;
    setCompany({ ...company, [field]: value });
  };

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-4xl">
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
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Changes
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
          <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
        ) : company ? (
          <div className="space-y-6">
            {/* Company Details */}
            <section className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Company Details</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className={LABEL_CLS}>Company Name *</label><input className={INPUT_CLS} value={company.name} onChange={e => update('name', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Trading Name</label><input className={INPUT_CLS} value={company.tradingName || ''} onChange={e => update('tradingName', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Registration Number</label><input className={INPUT_CLS} value={company.registrationNumber || ''} onChange={e => update('registrationNumber', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>VAT Number</label><input className={INPUT_CLS} value={company.vatNumber || ''} onChange={e => update('vatNumber', e.target.value)} placeholder="e.g. 4123456789" /></div>
                <div><label className={LABEL_CLS}>Income Tax Number</label><input className={INPUT_CLS} value={company.taxNumber || ''} onChange={e => update('taxNumber', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Email</label><input type="email" className={INPUT_CLS} value={company.email || ''} onChange={e => update('email', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Phone</label><input className={INPUT_CLS} value={company.phone || ''} onChange={e => update('phone', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Website</label><input className={INPUT_CLS} value={company.website || ''} onChange={e => update('website', e.target.value)} /></div>
              </div>
            </section>

            {/* Address */}
            <section className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Address</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 1</label><input className={INPUT_CLS} value={company.addressLine1 || ''} onChange={e => update('addressLine1', e.target.value)} /></div>
                <div className="md:col-span-2"><label className={LABEL_CLS}>Address Line 2</label><input className={INPUT_CLS} value={company.addressLine2 || ''} onChange={e => update('addressLine2', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>City</label><input className={INPUT_CLS} value={company.city || ''} onChange={e => update('city', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Province</label><input className={INPUT_CLS} value={company.province || ''} onChange={e => update('province', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Postal Code</label><input className={INPUT_CLS} value={company.postalCode || ''} onChange={e => update('postalCode', e.target.value)} /></div>
              </div>
            </section>

            {/* Banking */}
            <section className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Banking Details</h2>
              <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">Used on invoices and statements for payment instructions</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div><label className={LABEL_CLS}>Bank Name</label><input className={INPUT_CLS} value={company.bankName || ''} onChange={e => update('bankName', e.target.value)} placeholder="e.g. FNB, Standard Bank" /></div>
                <div><label className={LABEL_CLS}>Account Number</label><input className={INPUT_CLS} value={company.bankAccountNumber || ''} onChange={e => update('bankAccountNumber', e.target.value)} /></div>
                <div><label className={LABEL_CLS}>Branch Code</label><input className={INPUT_CLS} value={company.bankBranchCode || ''} onChange={e => update('bankBranchCode', e.target.value)} /></div>
              </div>
            </section>

            {/* Accounting Preferences */}
            <section className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Accounting Preferences</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={LABEL_CLS}>Financial Year Start Month</label>
                  <select className={INPUT_CLS} value={company.financialYearStart} onChange={e => update('financialYearStart', Number(e.target.value))}>
                    {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => (
                      <option key={i+1} value={i+1}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={LABEL_CLS}>VAT Period</label>
                  <select className={INPUT_CLS} value={company.vatPeriod} onChange={e => update('vatPeriod', e.target.value)}>
                    <option value="monthly">Monthly</option>
                    <option value="bi-monthly">Bi-Monthly</option>
                  </select>
                </div>
              </div>
            </section>
          </div>
        ) : (
          <div className="text-center py-12 text-[var(--ff-text-secondary)]">No company configured</div>
        )}
      </div>
    </AppLayout>
  );
}
