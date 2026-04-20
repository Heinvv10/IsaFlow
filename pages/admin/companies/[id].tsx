/**
 * Admin — Company Detail
 * Company info, subscription, users tab, features tab, and admin actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { CompanyBillingTab } from '@/components/admin/companies/CompanyBillingTab';
import { apiFetch } from '@/lib/apiFetch';
import { formatDate } from '@/utils/formatters';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import {
  ArrowLeft, AlertCircle, Loader2, Building2, ShieldOff, ShieldCheck,
  Trash2, Download, UserCog, ToggleLeft, ToggleRight, RotateCcw,
} from 'lucide-react';
import Link from 'next/link';

interface CompanyDetail {
  id: string;
  name: string;
  registration_number: string | null;
  vat_number: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  plan_name: string;
  billing_cycle: string;
  status: string;
  created_at: string;
  last_active: string | null;
}

interface CompanyUser {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  last_login: string | null;
}

interface CompanyFeature {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  source: 'global' | 'plan' | 'override';
}

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  suspended: 'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-gray-500',
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-900 dark:text-white">{value || '\u2014'}</p>
    </div>
  );
}

export default function AdminCompanyDetailPage() {
  const router    = useRouter();
  const adminHref = useAdminHref();
  const { id }    = router.query;

  const [company, setCompany]   = useState<CompanyDetail | null>(null);
  const [users, setUsers]       = useState<CompanyUser[]>([]);
  const [features, setFeatures] = useState<CompanyFeature[]>([]);
  const [loading, setLoading]   = useState(true);
  const [usersLoading, setUsersLoading]       = useState(false);
  const [featuresLoading, setFeaturesLoading] = useState(false);
  const [featureActionId, setFeatureActionId] = useState<string | null>(null);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState<'info' | 'users' | 'features' | 'billing'>('info');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError]     = useState('');
  const [suspendOpen, setSuspendOpen]     = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [deleteOpen, setDeleteOpen]       = useState(false);

  const load = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setLoading(true); setError('');
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load company');
      setCompany(json.data as CompanyDetail);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setLoading(false); }
  }, [id]);

  const loadUsers = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setUsersLoading(true);
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}/users`);
      const json = await res.json();
      if (res.ok) setUsers((json.data as CompanyUser[]) || []);
    } catch { /* non-critical */ }
    finally { setUsersLoading(false); }
  }, [id]);

  const loadFeatures = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setFeaturesLoading(true);
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}/features`);
      const json = await res.json();
      if (res.ok) setFeatures((json.data as CompanyFeature[]) || []);
    } catch { /* non-critical */ }
    finally { setFeaturesLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (activeTab === 'users')    void loadUsers();    }, [activeTab, loadUsers]);
  useEffect(() => { if (activeTab === 'features') void loadFeatures(); }, [activeTab, loadFeatures]);

  async function handleSuspend() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ reason: suspendReason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuspendOpen(false); setSuspendReason(''); void load();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed'); }
    finally { setActionLoading(false); }
  }

  async function handleActivate() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}/activate`, { method: 'POST', headers: { 'X-Admin-Request': 'true' } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      void load();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed'); }
    finally { setActionLoading(false); }
  }

  async function handleDelete() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}`, { method: 'DELETE', headers: { 'X-Admin-Request': 'true' } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      void router.push(adminHref('/admin/companies'));
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed'); setActionLoading(false); }
  }

  async function handleExport() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res = await apiFetch(`/api/admin/companies/${id}/export-data`);
      if (!res.ok) {
        const text = await res.text();
        let message = 'Export failed';
        try { const json = JSON.parse(text) as { message?: string; error?: { message?: string } }; message = json.message || json.error?.message || message; } catch { /* non-JSON error body — keep default */ }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `company-${id}-export.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Export failed'); }
    finally { setActionLoading(false); }
  }

  async function handleImpersonate() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}/impersonate`, { method: 'POST', headers: { 'X-Admin-Request': 'true' } });
      const json = await res.json();
      if (res.status === 429) throw new Error(json.error?.message || 'Rate limited — please wait a moment and try again');
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Impersonation failed');
      const token = (json.data as { token: string })?.token;
      if (token) {
        const appBase = process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin;
        window.open(`${appBase}/accounting?impersonate=${encodeURIComponent(token)}`, '_blank');
      } else {
        throw new Error('No token returned — impersonation failed');
      }
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Impersonation failed'); }
    finally { setActionLoading(false); }
  }

  async function handleFeatureToggle(feature: CompanyFeature) {
    if (!id || typeof id !== 'string') return;
    setFeatureActionId(feature.id);
    try {
      await apiFetch(`/api/admin/companies/${id}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ feature_id: feature.id, enabled: !feature.enabled, reason: 'Toggled via admin' }),
      });
      void loadFeatures();
    } catch { /* ignore */ }
    finally { setFeatureActionId(null); }
  }

  async function handleFeatureClearOverride(feature: CompanyFeature) {
    if (!id || typeof id !== 'string') return;
    setFeatureActionId(feature.id);
    try {
      await apiFetch(`/api/admin/companies/${id}/features`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ feature_id: feature.id }),
      });
      void loadFeatures();
    } catch { /* ignore */ }
    finally { setFeatureActionId(null); }
  }

  const address = company
    ? [company.address_line1, company.city, company.province, company.postal_code].filter(Boolean).join(', ')
    : null;

  return (
    <AdminLayout title="Company Detail">
      <Link href={adminHref('/admin/companies')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white mb-5 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Companies
      </Link>

      {[error, actionError].filter(Boolean).map((msg, i) => (
        <div key={i} className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {msg}
        </div>
      ))}

      {loading && <div className="flex items-center justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-teal-500" /></div>}

      {company && (
        <>
          <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-teal-500/10 rounded-lg"><Building2 className="w-6 h-6 text-teal-500" /></div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">{company.name}</h2>
                <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[company.status] ?? ''}`}>{company.status}</span>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => void handleExport()} disabled={actionLoading}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
                <Download className="w-4 h-4" /> Export Data
              </button>
              <button onClick={() => void handleImpersonate()} disabled={actionLoading}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-blue-400 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50">
                <UserCog className="w-4 h-4" /> Impersonate
              </button>
              {company.status !== 'suspended'
                ? <button onClick={() => setSuspendOpen(true)} disabled={actionLoading}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-yellow-400 text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10 transition-colors disabled:opacity-50">
                    <ShieldOff className="w-4 h-4" /> Suspend
                  </button>
                : <button onClick={() => void handleActivate()} disabled={actionLoading}
                    className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-teal-400 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10 transition-colors disabled:opacity-50">
                    <ShieldCheck className="w-4 h-4" /> Activate
                  </button>
              }
              <button onClick={() => setDeleteOpen(true)} disabled={actionLoading}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50">
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </div>
          </div>

          <div className="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700">
            {(['info', 'users', 'features', 'billing'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${ activeTab === tab ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}>
                {tab}
              </button>
            ))}
          </div>

          {activeTab === 'info' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Company Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Registration #" value={company.registration_number} />
                  <Field label="VAT Number"      value={company.vat_number} />
                  <Field label="Email"           value={company.email} />
                  <Field label="Phone"           value={company.phone} />
                  <Field label="Created"         value={formatDate(company.created_at)} />
                  <Field label="Last Active"     value={formatDate(company.last_active)} />
                  <div className="col-span-2"><Field label="Address" value={address} /></div>
                </div>
              </div>
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Subscription</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Plan"          value={company.plan_name} />
                  <Field label="Billing Cycle" value={company.billing_cycle} />
                  <Field label="Status"        value={company.status} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'users' && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
              {usersLoading
                ? <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-teal-500" /></div>
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                          <th className="px-4 py-3 font-medium">Name</th>
                          <th className="px-4 py-3 font-medium">Email</th>
                          <th className="px-4 py-3 font-medium">Role</th>
                          <th className="px-4 py-3 font-medium">Last Login</th>
                        </tr>
                      </thead>
                      <tbody>
                        {users.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-600 dark:text-gray-400">No users</td></tr>}
                        {users.map(u => (
                          <tr key={u.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{u.first_name} {u.last_name}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{u.email}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{u.role}</td>
                            <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{formatDate(u.last_login)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </div>
          )}

          {activeTab === 'billing' && (
            <CompanyBillingTab companyId={company.id} />
          )}

          {activeTab === 'features' && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
              {featuresLoading
                ? <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-teal-500" /></div>
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                          <th className="px-4 py-3 font-medium">Feature</th>
                          <th className="px-4 py-3 font-medium">Code</th>
                          <th className="px-4 py-3 font-medium">Source</th>
                          <th className="px-4 py-3 font-medium text-center">Enabled</th>
                          <th className="px-4 py-3 font-medium text-center">Override</th>
                        </tr>
                      </thead>
                      <tbody>
                        {features.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-600 dark:text-gray-400">No feature flags configured</td></tr>}
                        {features.map(f => (
                          <tr key={f.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{f.name}</td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{f.code}</td>
                            <td className="px-4 py-3">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${ f.source === 'override' ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400' : f.source === 'global' ? 'bg-teal-500/10 text-teal-600 dark:text-teal-400' : 'bg-blue-500/10 text-blue-600 dark:text-blue-400' }`}>
                                {f.source}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button
                                onClick={() => void handleFeatureToggle(f)}
                                disabled={featureActionId === f.id}
                                className="inline-flex items-center justify-center disabled:opacity-50 transition-colors"
                              >
                                {featureActionId === f.id
                                  ? <Loader2 className="w-5 h-5 animate-spin text-gray-600 dark:text-gray-400" />
                                  : f.enabled
                                    ? <ToggleRight className="w-6 h-6 text-teal-500" />
                                    : <ToggleLeft className="w-6 h-6 text-gray-600 dark:text-gray-400" />
                                }
                              </button>
                            </td>
                            <td className="px-4 py-3 text-center">
                              {f.source === 'override' && (
                                <button
                                  title="Reset to default"
                                  onClick={() => void handleFeatureClearOverride(f)}
                                  disabled={featureActionId === f.id}
                                  className="p-1 rounded text-gray-600 dark:text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                >
                                  <RotateCcw className="w-4 h-4" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </div>
          )}
        </>
      )}

      <ConfirmModal
        open={suspendOpen}
        title="Suspend Company"
        message="This will immediately prevent all users from accessing the company. Provide a reason below."
        confirmLabel="Suspend"
        confirmClass="bg-yellow-500 hover:bg-yellow-600"
        loading={actionLoading}
        onConfirm={() => void handleSuspend()}
        onCancel={() => setSuspendOpen(false)}
      >
        <textarea rows={3} value={suspendReason} onChange={e => setSuspendReason(e.target.value)}
          placeholder="Reason for suspension..."
          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-yellow-500 resize-none"
        />
      </ConfirmModal>

      <ConfirmModal
        open={deleteOpen}
        title="Delete Company"
        message={<>This action is <strong>permanent</strong>. All data for <strong>{company?.name}</strong> will be deleted and cannot be recovered.</>}
        confirmLabel="Delete Permanently"
        loading={actionLoading}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteOpen(false)}
      />
    </AdminLayout>
  );
}
