/**
 * Admin — User Detail
 * Profile, company memberships, and admin actions.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatDate } from '@/utils/formatters';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import {
  ArrowLeft, AlertCircle, Loader2, User, CheckCircle2,
  ShieldOff, ShieldCheck, KeyRound, LogOut, Pencil, Check, X,
  Plus, Trash2, RotateCcw,
} from 'lucide-react';
import Link from 'next/link';

interface UserDetail {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  role: string;
  status: 'active' | 'suspended' | 'inactive';
  last_login: string | null;
  login_count: number;
  created_at: string;
  department: string | null;
  last_login_ip: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  companies: UserCompany[];
}

interface UserCompany { company_id: string; company_name: string; role: string; is_default: boolean; }
interface CompanyOption { id: string; name: string; }

const COMPANY_ROLES = ['admin', 'accountant', 'bookkeeper', 'viewer'];

const ROLES = ['super_admin', 'admin', 'manager', 'storeman', 'technician', 'viewer'];

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  suspended: 'bg-red-500/10 text-red-500',
  inactive:  'bg-gray-500/10 text-gray-500',
};

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-900 dark:text-white">{value || '\u2014'}</p>
    </div>
  );
}

export default function AdminUserDetailPage() {
  const router = useRouter();
  const adminHref = useAdminHref();
  const { id } = router.query;

  const [user, setUser]           = useState<UserDetail | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState<'profile' | 'companies'>('profile');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError]     = useState('');
  const [editing, setEditing]     = useState(false);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName]   = useState('');
  const [editPhone, setEditPhone]         = useState('');
  const [editRole, setEditRole]           = useState('');
  // Company link state
  const [allCompanies, setAllCompanies]     = useState<CompanyOption[]>([]);
  const [showLinkForm, setShowLinkForm]     = useState(false);
  const [linkCompanyId, setLinkCompanyId]   = useState('');
  const [linkRole, setLinkRole]             = useState('bookkeeper');
  // Inline confirm state (avoids confirm() dialogs which Playwright/popup-blockers break)
  const [confirmAction, setConfirmAction]   = useState<string | null>(null);
  // Toast notification
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  const load = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setLoading(true); setError('');
    try {
      const res  = await apiFetch(`/api/admin/users/${id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load user');
      const u = json.data as UserDetail;
      setUser(u);
      setEditFirstName(u.first_name); setEditLastName(u.last_name);
      setEditPhone(u.phone ?? '');    setEditRole(u.role);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Fetch all companies for the link dropdown
  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch('/api/admin/companies?limit=100');
        const json = await res.json();
        if (res.ok) {
          const items = (json.data?.items ?? []) as CompanyOption[];
          setAllCompanies(items);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  async function doAction(endpoint: string, method = 'POST', body?: object) {
    if (!id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      const url = endpoint
        ? `/api/admin/users/${id}/${endpoint}`
        : `/api/admin/users/${id}`;
      const res  = await apiFetch(url, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      return true;
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Failed'); return false; }
    finally { setActionLoading(false); }
  }

  async function handleSaveEdit() {
    const ok = await doAction('', 'PATCH', {
      first_name: editFirstName, last_name: editLastName,
      phone: editPhone, role: editRole,
    });
    if (ok) { setEditing(false); showToast('Profile updated'); void load(); }
  }

  async function handleResetPassword() {
    const ok = await doAction('reset-password');
    if (ok) showToast('Password reset sent');
  }

  async function handleToggleSuspend() {
    if (user?.status === 'suspended') {
      const ok = await doAction('activate');
      if (ok) { showToast('User activated'); void load(); }
    } else {
      const ok = await doAction('suspend', 'POST', { reason: 'Suspended by admin' });
      if (ok) { showToast('User suspended'); void load(); }
    }
  }

  async function handleForceLogout() {
    const ok = await doAction('force-logout');
    if (ok) showToast('All sessions cleared');
  }

  async function handleLinkCompany() {
    if (!linkCompanyId || !linkRole) return;
    const ok = await doAction('add-to-company', 'POST', { company_id: linkCompanyId, role: linkRole });
    if (ok) { setShowLinkForm(false); setLinkCompanyId(''); setLinkRole('bookkeeper'); showToast('Company linked'); void load(); }
  }

  async function handleDelinkCompany(companyId: string) {
    const ok = await doAction('remove-from-company', 'DELETE', { company_id: companyId });
    if (ok) { showToast('Company removed'); void load(); }
  }

  /** Two-click confirm for destructive action */
  function confirmAndRun(key: string, action: () => void) {
    if (confirmAction === key) { setConfirmAction(null); action(); }
    else { setConfirmAction(key); setTimeout(() => setConfirmAction(prev => prev === key ? null : prev), 3000); }
  }

  async function handleResetOnboarding() {
    const ok = await doAction('reset-onboarding');
    if (ok) { showToast('Onboarding reset — user will re-onboard on next login'); void load(); }
  }

  const companies = user?.companies ?? [];

  return (
    <AdminLayout title="User Detail">
      <Link href={adminHref('/admin/users')}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white mb-5 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Users
      </Link>

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
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">{user.first_name} {user.last_name}</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400">{user.email}</p>
                <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[user.status] ?? ''}`}>{user.status}</span>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => setEditing(e => !e)} disabled={actionLoading}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={() => confirmAndRun('reset-password', () => void handleResetPassword())} disabled={actionLoading}
                className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                  confirmAction === 'reset-password' ? 'border-red-500 bg-red-500 text-white' : 'border-blue-400 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10'}`}>
                <KeyRound className="w-4 h-4" /> {confirmAction === 'reset-password' ? 'Click to confirm' : 'Reset Password'}
              </button>
              <button onClick={() => confirmAndRun('suspend', () => void handleToggleSuspend())} disabled={actionLoading}
                className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                  confirmAction === 'suspend' ? 'border-red-500 bg-red-500 text-white'
                  : user.status === 'suspended'
                    ? 'border-teal-400 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10'
                    : 'border-yellow-400 text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'}`}>
                {confirmAction === 'suspend'
                  ? <><ShieldOff className="w-4 h-4" /> Click to confirm</>
                  : user.status === 'suspended' ? <><ShieldCheck className="w-4 h-4" /> Activate</> : <><ShieldOff className="w-4 h-4" /> Suspend</>}
              </button>
              <button onClick={() => confirmAndRun('force-logout', () => void handleForceLogout())} disabled={actionLoading}
                className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                  confirmAction === 'force-logout' ? 'border-red-500 bg-red-500 text-white' : 'border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'}`}>
                <LogOut className="w-4 h-4" /> {confirmAction === 'force-logout' ? 'Click to confirm' : 'Force Logout'}
              </button>
              <button onClick={() => confirmAndRun('reset-onboarding', () => void handleResetOnboarding())} disabled={actionLoading}
                className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50 ${
                  confirmAction === 'reset-onboarding' ? 'border-red-500 bg-red-500 text-white' : 'border-orange-400 text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/10'}`}>
                <RotateCcw className="w-4 h-4" /> {confirmAction === 'reset-onboarding' ? 'Click to confirm' : 'Reset Onboarding'}
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
                  <Field label="First Name"  value={user.first_name} />
                  <Field label="Last Name"   value={user.last_name} />
                  <Field label="Email"       value={user.email} />
                  <Field label="Phone"       value={user.phone} />
                  <Field label="Role"        value={user.role} />
                  <Field label="Status"      value={user.status} />
                  <Field label="Last Login"  value={formatDate(user.last_login)} />
                  <Field label="Login Count" value={String(user.login_count)} />
                  <Field label="Created"     value={formatDate(user.created_at)} />
                </div>
              )}
            </div>
          )}

          {activeTab === 'companies' && (
            <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Linked Companies</h3>
                <button onClick={() => setShowLinkForm(f => !f)} disabled={actionLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors disabled:opacity-50">
                  <Plus className="w-3.5 h-3.5" /> Link Company
                </button>
              </div>

              {showLinkForm && (
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-end gap-3 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Company</label>
                    <select value={linkCompanyId} onChange={e => setLinkCompanyId(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
                      <option value="">Select company...</option>
                      {allCompanies
                        .filter(co => !companies.some(uc => uc.company_id === co.id))
                        .map(co => <option key={co.id} value={co.id}>{co.name}</option>)}
                    </select>
                  </div>
                  <div className="w-40">
                    <label className="text-xs text-gray-500 dark:text-gray-400 block mb-1">Role</label>
                    <select value={linkRole} onChange={e => setLinkRole(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500">
                      {COMPANY_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => void handleLinkCompany()} disabled={actionLoading || !linkCompanyId}
                      className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium bg-teal-600 hover:bg-teal-700 text-white rounded-lg disabled:opacity-50 transition-colors">
                      {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Add
                    </button>
                    <button onClick={() => setShowLinkForm(false)}
                      className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                      <X className="w-3.5 h-3.5" /> Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                      <th className="px-4 py-3 font-medium">Company</th>
                      <th className="px-4 py-3 font-medium">Role</th>
                      <th className="px-4 py-3 font-medium">Default</th>
                      <th className="px-4 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companies.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No companies linked</td></tr>}
                    {companies.map(c => (
                      <tr key={c.company_id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{c.company_name}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-300 capitalize">{c.role}</td>
                        <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{c.is_default ? 'Yes' : '\u2014'}</td>
                        <td className="px-4 py-3 text-right">
                          <button onClick={() => confirmAndRun(`delink-${c.company_id}`, () => void handleDelinkCompany(c.company_id))} disabled={actionLoading}
                            className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
                              confirmAction === `delink-${c.company_id}` ? 'bg-red-500 text-white' : 'text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'}`}>
                            <Trash2 className="w-3.5 h-3.5" /> {confirmAction === `delink-${c.company_id}` ? 'Sure?' : 'Remove'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg bg-teal-600 text-white text-sm font-medium shadow-lg animate-[fadeIn_0.2s_ease-out]">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {toast}
        </div>
      )}
    </AdminLayout>
  );
}
