/**
 * Admin — User Detail
 * Profile, company memberships, and admin actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  ArrowLeft, AlertCircle, Loader2, User,
  ShieldOff, ShieldCheck, KeyRound, LogOut, Pencil, Check, X,
} from 'lucide-react';

interface UserDetail {
  id: string; firstName: string; lastName: string;
  email: string; phone: string | null; role: string;
  status: 'active' | 'suspended' | 'inactive';
  lastLoginAt: string | null; loginCount: number; createdAt: string;
}

interface UserCompany { id: string; name: string; role: string; status: string; }

const ROLES = ['super_admin', 'admin', 'manager', 'storeman', 'technician', 'viewer'];

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  suspended: 'bg-red-500/10 text-red-500',
  inactive:  'bg-gray-500/10 text-gray-500',
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

export default function AdminUserDetailPage() {
  const router = useRouter();
  const { id } = router.query;

  const [user, setUser]           = useState<UserDetail | null>(null);
  const [companies, setCompanies] = useState<UserCompany[]>([]);
  const [loading, setLoading]     = useState(true);
  const [companiesLoading, setCompaniesLoading] = useState(false);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState<'profile' | 'companies'>('profile');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError]     = useState('');
  const [editing, setEditing]     = useState(false);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName]   = useState('');
  const [editPhone, setEditPhone]         = useState('');
  const [editRole, setEditRole]           = useState('');

  const load = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setLoading(true); setError('');
    try {
      const res  = await apiFetch(`/api/admin/users/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load user');
      const u = json.data as UserDetail;
      setUser(u);
      setEditFirstName(u.firstName); setEditLastName(u.lastName);
      setEditPhone(u.phone ?? '');   setEditRole(u.role);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setLoading(false); }
  }, [id]);

  const loadCompanies = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setCompaniesLoading(true);
    try {
      const res  = await apiFetch(`/api/admin/users/${id}/companies`);
      const json = await res.json();
      if (res.ok) setCompanies((json.data as UserCompany[]) || []);
    } catch { /* non-critical */ }
    finally { setCompaniesLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (activeTab === 'companies') void loadCompanies(); }, [activeTab, loadCompanies]);

  async function doAction(endpoint: string, method = 'POST', body?: object) {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/users/${id}/${endpoint}`, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      return true;
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed'); return false; }
    finally { setActionLoading(false); }
  }

  async function handleSaveEdit() {
    const ok = await doAction('', 'PATCH', {
      firstName: editFirstName, lastName: editLastName,
      phone: editPhone, role: editRole,
    });
    if (ok) { setEditing(false); void load(); }
  }

  async function handleResetPassword() {
    if (!confirm('Send password reset email to this user?')) return;
    await doAction('reset-password');
  }

  async function handleToggleSuspend() {
    const action = user?.status === 'suspended' ? 'activate' : 'suspend';
    if (!confirm(`${action === 'activate' ? 'Activate' : 'Suspend'} this user?`)) return;
    const ok = await doAction(action);
    if (ok) void load();
  }

  async function handleForceLogout() {
    if (!confirm('Force logout this user from all sessions?')) return;
    await doAction('force-logout');
  }

  return (
    <AdminLayout title="User Detail">
      <button onClick={() => void router.push('/admin/users')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white mb-5 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Users
      </button>

      {[error, actionError].filter(Boolean).map((msg, i) => (
        <div key={i} className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {msg}
        </div>
      ))}

      {loading && <div className="flex items-center justify-center py-24"><Loader2 className="w-6 h-6 animate-spin text-teal-500" /></div>}

      {user && (
        <>
          <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-teal-600 flex items-center justify-center flex-shrink-0">
                <User className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">{user.firstName} {user.lastName}</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">{user.email}</p>
                <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[user.status] ?? ''}`}>{user.status}</span>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => setEditing(e => !e)} disabled={actionLoading}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={() => void handleResetPassword()} disabled={actionLoading}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-blue-400 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50">
                <KeyRound className="w-4 h-4" /> Reset Password
              </button>
              <button onClick={() => void handleToggleSuspend()} disabled={actionLoading}
                className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                  user.status === 'suspended'
                    ? 'border-teal-400 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10'
                    : 'border-yellow-400 text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'}`}>
                {user.status === 'suspended' ? <><ShieldCheck className="w-4 h-4" /> Activate</> : <><ShieldOff className="w-4 h-4" /> Suspend</>}
              </button>
              <button onClick={() => void handleForceLogout()} disabled={actionLoading}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50">
                <LogOut className="w-4 h-4" /> Force Logout
              </button>
            </div>
          </div>

          <div className="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700">
            {(['profile', 'companies'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
                  activeTab === tab ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}>
                {tab}
              </button>
            ))}
          </div>

          {activeTab === 'profile' && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Profile Information</h3>
                {editing && (
                  <div className="flex gap-2">
                    <button onClick={() => void handleSaveEdit()} disabled={actionLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-teal-600 hover:bg-teal-700 text-white rounded-lg disabled:opacity-50 transition-colors">
                      {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
                    </button>
                    <button onClick={() => setEditing(false)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                      <X className="w-3.5 h-3.5" /> Cancel
                    </button>
                  </div>
                )}
              </div>
              {editing ? (
                <div className="grid grid-cols-2 gap-4">
                  {[
                    ['First Name', editFirstName, setEditFirstName],
                    ['Last Name',  editLastName,  setEditLastName],
                    ['Phone',      editPhone,     setEditPhone],
                  ].map(([label, value, setter]) => (
                    <div key={label as string}>
                      <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">{label as string}</label>
                      <input value={value as string} onChange={e => (setter as (v: string) => void)(e.target.value)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500" />
                    </div>
                  ))}
                  <div>
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Role</label>
                    <select value={editRole} onChange={e => setEditRole(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
                      {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                  <Field label="First Name"  value={user.firstName} />
                  <Field label="Last Name"   value={user.lastName} />
                  <Field label="Email"       value={user.email} />
                  <Field label="Phone"       value={user.phone} />
                  <Field label="Role"        value={user.role} />
                  <Field label="Status"      value={user.status} />
                  <Field label="Last Login"  value={fmtDate(user.lastLoginAt)} />
                  <Field label="Login Count" value={String(user.loginCount)} />
                  <Field label="Created"     value={fmtDate(user.createdAt)} />
                </div>
              )}
            </div>
          )}

          {activeTab === 'companies' && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
              {companiesLoading
                ? <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-teal-500" /></div>
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                          <th className="px-4 py-3 font-medium">Company</th>
                          <th className="px-4 py-3 font-medium">Role</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {companies.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-400">No companies</td></tr>}
                        {companies.map(c => (
                          <tr key={c.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                            <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.name}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{c.role}</td>
                            <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{c.status}</td>
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
    </AdminLayout>
  );
}
