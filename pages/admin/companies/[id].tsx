/**
 * Admin — Company Detail
 * Company info, subscription, users tab, features tab, and admin actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { CompanyBillingTab } from '@/components/admin/companies/CompanyBillingTab';
import { CompanyActionBar } from '@/components/admin/companies/CompanyActionBar';
import { CompanyInfoTab } from '@/components/admin/companies/CompanyInfoTab';
import { CompanyUsersTab } from '@/components/admin/companies/CompanyUsersTab';
import type { CompanyDetail, CompanyUser } from '@/components/admin/companies/companyDetailModel';
import { useCompanyEdit } from '@/components/admin/companies/useCompanyEdit';
import { useCompanyFeatures } from '@/components/admin/companies/useCompanyFeatures';
import { ApiEnvelopeError, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { useAdminHref, tenantAppUrl } from '@/hooks/useAdminPrefix';
import { ArrowLeft, AlertCircle, Loader2, ToggleLeft, ToggleRight, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { adminFetch } from '@/lib/admin/adminFetch';


export default function AdminCompanyDetailPage() {
  const router    = useRouter();
  const adminHref = useAdminHref();
  const { id }    = router.query;

  const [company, setCompany]   = useState<CompanyDetail | null>(null);
  const [users, setUsers]       = useState<CompanyUser[]>([]);
  const [loading, setLoading]   = useState(true);
  const [usersLoading, setUsersLoading]       = useState(false);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState<'info' | 'users' | 'features' | 'billing'>('info');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError]     = useState('');
  const [suspendOpen, setSuspendOpen]     = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [deleteOpen, setDeleteOpen]       = useState(false);
  const edit = useCompanyEdit(id, company, setCompany);
  const { features, featuresLoading, featureActionId, loadFeatures, handleFeatureToggle, handleFeatureClearOverride } =
    useCompanyFeatures(id, setActionError);

  const load = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setLoading(true); setError('');
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}`);
      await assertOk(res, 'Could not load the company - try again');
      const json = await res.json();
      setCompany(json.data as CompanyDetail);
    } catch (err) { setCompany(null); setError(apiErrorMessage(err, 'Could not load the company - try again')); }
    finally { setLoading(false); }
  }, [id]);

  const loadUsers = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setUsersLoading(true);
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}/users`);
      await assertOk(res, 'Could not load the company users - try again');
      const json = await res.json();
      setUsers((json.data as CompanyUser[]) || []);
    } catch (err) { setUsers([]); setActionError(apiErrorMessage(err, 'Could not load the company users - try again')); }
    finally { setUsersLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (activeTab === 'users')    void loadUsers();    }, [activeTab, loadUsers]);
  useEffect(() => { if (activeTab === 'features') void loadFeatures(); }, [activeTab, loadFeatures]);

  async function handleSuspend() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: suspendReason }),
      });
      await assertOk(res, 'Could not suspend the company - try again');
      setSuspendOpen(false); setSuspendReason(''); void load();
    } catch (err) { setActionError(apiErrorMessage(err, 'Could not suspend the company - try again')); }
    finally { setActionLoading(false); }
  }

  async function handleActivate() {
    if (!id || typeof id !== 'string') return;
    const action = company?.status === 'deleted' ? 'restore' : 'activate';
    setActionLoading(true); setActionError('');
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}/${action}`, { method: 'POST' });
      await assertOk(res, `Could not ${action} the company - try again`);
      void load();
    } catch (err) { setActionError(apiErrorMessage(err, `Could not ${action} the company - try again`)); }
    finally { setActionLoading(false); }
  }

  async function handleDelete() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}`, { method: 'DELETE' });
      await assertOk(res, 'Could not delete the company - try again');
      void router.push(adminHref('/admin/companies'));
    } catch (err) { setActionError(apiErrorMessage(err, 'Could not delete the company - try again')); setActionLoading(false); }
  }

  async function handleExport() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res = await adminFetch(`/api/admin/companies/${id}/export-data`);
      await assertOk(res, 'Could not export the company data - try again');
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `company-${id}-export.json`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { setActionError(apiErrorMessage(err, 'Could not export the company data - try again')); }
    finally { setActionLoading(false); }
  }

  async function handleImpersonate() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await adminFetch(`/api/admin/companies/${id}/impersonate`, { method: 'POST' });
      await assertOk(res, res.status === 429 ? 'Too many attempts - please wait a moment and try again' : 'Could not start impersonation - try again');
      const json = await res.json();
      const token = (json.data as { token: string })?.token;
      if (token) {
        window.open(tenantAppUrl(`/accounting?impersonate=${encodeURIComponent(token)}`), '_blank', 'noopener,noreferrer');
      } else {
        throw new ApiEnvelopeError('No token was returned, so impersonation could not start');
      }
    } catch (err) { setActionError(apiErrorMessage(err, 'Could not start impersonation - try again')); }
    finally { setActionLoading(false); }
  }

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
          <CompanyActionBar
            company={company}
            actionLoading={actionLoading}
            onExport={() => void handleExport()}
            onImpersonate={() => void handleImpersonate()}
            onSuspend={() => setSuspendOpen(true)}
            onActivate={() => void handleActivate()}
            onDelete={() => setDeleteOpen(true)}
          />

          <div className="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700">
            {(['info', 'users', 'features', 'billing'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${ activeTab === tab ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}>
                {tab}
              </button>
            ))}
          </div>

          {activeTab === 'info' && <CompanyInfoTab company={company} edit={edit} />}

          {activeTab === 'users' && <CompanyUsersTab users={users} usersLoading={usersLoading} />}

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
        confirmDisabled={suspendReason.trim() === ''}
        onConfirm={() => void handleSuspend()}
        onCancel={() => setSuspendOpen(false)}
      >
        <textarea rows={3} aria-label="Reason for suspension" value={suspendReason} onChange={e => setSuspendReason(e.target.value)}
          placeholder="Reason for suspension..."
          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-yellow-500 resize-none"
        />
      </ConfirmModal>

      <ConfirmModal
        open={deleteOpen}
        title="Delete Company"
        message={<>Users lose access to <strong>{company?.name}</strong> and its subscription is no longer charged. Its data is kept: filter the Companies list by Deleted, open it and click Restore.</>}
        confirmLabel="Delete Company"
        loading={actionLoading}
        onConfirm={() => void handleDelete()}
        onCancel={() => setDeleteOpen(false)}
      />
    </AdminLayout>
  );
}
