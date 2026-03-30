/**
 * Admin — Company Detail
 * Company info, subscription, users tab, and admin actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { apiFetch } from '@/lib/apiFetch';
import { ArrowLeft, AlertCircle, Loader2, Building2, ShieldOff, ShieldCheck, Trash2 } from 'lucide-react';

interface CompanyDetail {
  id: string; name: string;
  registrationNumber: string | null; vatNumber: string | null;
  email: string | null; phone: string | null; address: string | null;
  plan: string; billingCycle: string; status: string;
  createdAt: string; lastActiveAt: string | null;
}

interface CompanyUser {
  id: string; name: string; email: string; role: string; lastLoginAt: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  trial:     'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  suspended: 'bg-red-500/10 text-red-500',
  cancelled: 'bg-gray-500/10 text-gray-500',
};

const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('en-ZA') : '—';

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-900 dark:text-white">{value || '—'}</p>
    </div>
  );
}

export default function AdminCompanyDetailPage() {
  const router = useRouter();
  const { id } = router.query;

  const [company, setCompany]   = useState<CompanyDetail | null>(null);
  const [users, setUsers]       = useState<CompanyUser[]>([]);
  const [loading, setLoading]   = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);
  const [error, setError]       = useState('');
  const [activeTab, setActiveTab] = useState<'info' | 'users'>('info');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError]     = useState('');
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [deleteOpen, setDeleteOpen]   = useState(false);

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

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (activeTab === 'users') void loadUsers(); }, [activeTab, loadUsers]);

  async function handleSuspend() {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/companies/${id}/suspend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const res  = await apiFetch(`/api/admin/companies/${id}/activate`, { method: 'POST' });
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
      const res  = await apiFetch(`/api/admin/companies/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      void router.push('/admin/companies');
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed'); setActionLoading(false); }
  }

  return (
    <AdminLayout title="Company Detail">
      <button onClick={() => void router.push('/admin/companies')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white mb-5 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Companies
      </button>

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
            {(['info', 'users'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
                  activeTab === tab ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}>
                {tab}
              </button>
            ))}
          </div>

          {activeTab === 'info' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Company Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Registration #" value={company.registrationNumber} />
                  <Field label="VAT Number"      value={company.vatNumber} />
                  <Field label="Email"           value={company.email} />
                  <Field label="Phone"           value={company.phone} />
                  <Field label="Created"         value={fmtDate(company.createdAt)} />
                  <Field label="Last Active"     value={fmtDate(company.lastActiveAt)} />
                  <div className="col-span-2"><Field label="Address" value={company.address} /></div>
                </div>
              </div>
              <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Subscription</h3>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Plan"          value={company.plan} />
                  <Field label="Billing Cycle" value={company.billingCycle} />
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
                        {users.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No users</td></tr>}
                        {users.map(u => (
                          <tr key={u.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{u.name}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{u.email}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{u.role}</td>
                            <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{fmtDate(u.lastLoginAt)}</td>
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
          placeholder="Reason for suspension…"
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
