/**
 * Admin — User Detail
 * Profile, company memberships, audit log, and admin actions.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import {
  ArrowLeft, AlertCircle, Loader2, User, CheckCircle2,
  ShieldOff, ShieldCheck, KeyRound, LogOut, Pencil, RotateCcw, UserCog,
} from 'lucide-react';
import Link from 'next/link';
import { UserCompaniesTable, type UserCompany, type CompanyOption } from '@/components/admin/users/UserCompaniesTable';
import { UserAuditLog } from '@/components/admin/users/UserAuditLog';
import { UserProfileForm } from '@/components/admin/users/UserProfileForm';
import { log } from '@/lib/logger';

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
  companies: UserCompany[];
}

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  suspended: 'bg-red-500/10 text-red-500',
  inactive:  'bg-gray-500/10 text-gray-500',
};

export default function AdminUserDetailPage() {
  const router    = useRouter();
  const adminHref = useAdminHref();
  const { id }    = router.query;

  const [user, setUser]           = useState<UserDetail | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [activeTab, setActiveTab] = useState<'profile' | 'companies' | 'audit'>('profile');
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError]     = useState('');
  const [editing, setEditing]             = useState(false);
  const [editState, setEditState]         = useState({ firstName: '', lastName: '', phone: '', role: '' });
  const [allCompanies, setAllCompanies]   = useState<CompanyOption[]>([]);
  const [confirmAction, setConfirmAction] = useState<string | null>(null);
  const [toast, setToast]                 = useState<string | null>(null);
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
      setEditState({ firstName: u.first_name, lastName: u.last_name, phone: u.phone ?? '', role: u.role });
    } catch (err) {
      log.error('AdminUserDetail load failed', { userId: id, error: err }, 'admin-ui');
      setError(err instanceof Error ? err.message : 'Failed to load user');
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    (async () => {
      try {
        const res  = await apiFetch('/api/admin/companies?limit=100');
        const json = await res.json();
        if (res.ok) setAllCompanies((json.data?.items ?? []) as CompanyOption[]);
      } catch (err) { log.error('Failed to load companies', { error: err }, 'admin-ui'); }
    })();
  }, []);

  async function doAction(endpoint: string, method = 'POST', body?: object): Promise<boolean> {
    if (!id || typeof id !== 'string') return false;
    setActionLoading(true); setActionError('');
    try {
      const url = endpoint ? `/api/admin/users/${id}/${endpoint}` : `/api/admin/users/${id}`;
      const res  = await apiFetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed');
      return false;
    } finally { setActionLoading(false); }
  }

  function confirmAndRun(key: string, action: () => void) {
    if (confirmAction === key) { setConfirmAction(null); action(); }
    else { setConfirmAction(key); setTimeout(() => setConfirmAction(prev => prev === key ? null : prev), 3000); }
  }

  async function handleSaveEdit() {
    const ok = await doAction('', 'PATCH', { first_name: editState.firstName, last_name: editState.lastName, phone: editState.phone, role: editState.role });
    if (ok) { setEditing(false); showToast('Profile updated'); void load(); }
  }

  async function handleImpersonate() {
    if (!user) return;
    const defaultCompany = user.companies.find(c => c.is_default) ?? user.companies[0];
    if (!defaultCompany) { setActionError('User has no linked company to impersonate'); return; }
    setActionLoading(true); setActionError('');
    try {
      const res  = await apiFetch(`/api/admin/companies/${defaultCompany.company_id}/impersonate`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to create impersonation token');
      const token = (json.data as { token: string }).token;
      window.open(`/accounting?impersonate=${encodeURIComponent(token)}`, '_blank');
      showToast('Impersonation session opened');
    } catch (err) {
      log.error('Impersonation failed', { userId: user.id, error: err }, 'admin-ui');
      setActionError(err instanceof Error ? err.message : 'Failed to impersonate');
    } finally { setActionLoading(false); }
  }

  async function handleToggleSuspend() {
    const endpoint = user?.status === 'suspended' ? 'activate' : 'suspend';
    const body     = endpoint === 'suspend' ? { reason: 'Suspended by admin' } : undefined;
    const ok = await doAction(endpoint, 'POST', body);
    if (ok) { showToast(endpoint === 'activate' ? 'User activated' : 'User suspended'); void load(); }
  }

  async function handleLinkCompany(companyId: string, role: string) {
    const ok = await doAction('add-to-company', 'POST', { company_id: companyId, role });
    if (ok) { showToast('Company linked'); void load(); }
  }

  async function handleDelinkCompany(companyId: string) {
    const ok = await doAction('remove-from-company', 'DELETE', { company_id: companyId });
    if (ok) { showToast('Company removed'); void load(); }
  }

  const btnBase  = 'inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-50';
  const btnGray  = `${btnBase} border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800`;
  const btnBlue  = `${btnBase} border-blue-400 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10`;
  const btnRed   = `${btnBase} border-red-400 text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10`;
  const btnOrange = `${btnBase} border-orange-400 text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-500/10`;

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
              <button onClick={() => setEditing(e => !e)} disabled={actionLoading} className={btnGray}>
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={() => void handleImpersonate()} disabled={actionLoading} className={btnBlue}>
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCog className="w-4 h-4" />} Impersonate
              </button>
              <button onClick={() => confirmAndRun('reset-password', () => void doAction('reset-password').then(ok => ok && showToast('Password reset sent')))} disabled={actionLoading}
                className={`${btnBase} ${confirmAction === 'reset-password' ? 'border-red-500 bg-red-500 text-white' : 'border-blue-400 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10'}`}>
                <KeyRound className="w-4 h-4" /> {confirmAction === 'reset-password' ? 'Click to confirm' : 'Reset Password'}
              </button>
              <button onClick={() => confirmAndRun('suspend', () => void handleToggleSuspend())} disabled={actionLoading}
                className={`${btnBase} ${confirmAction === 'suspend' ? 'border-red-500 bg-red-500 text-white' : user.status === 'suspended' ? 'border-teal-400 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-500/10' : 'border-yellow-400 text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'}`}>
                {confirmAction === 'suspend' ? <><ShieldOff className="w-4 h-4" /> Click to confirm</> : user.status === 'suspended' ? <><ShieldCheck className="w-4 h-4" /> Activate</> : <><ShieldOff className="w-4 h-4" /> Suspend</>}
              </button>
              <button onClick={() => confirmAndRun('force-logout', () => void doAction('force-logout').then(ok => ok && showToast('All sessions cleared')))} disabled={actionLoading}
                className={`${btnBase} ${confirmAction === 'force-logout' ? 'border-red-500 bg-red-500 text-white' : btnRed.split(' ').slice(1).join(' ')}`}>
                <LogOut className="w-4 h-4" /> {confirmAction === 'force-logout' ? 'Click to confirm' : 'Force Logout'}
              </button>
              <button onClick={() => confirmAndRun('reset-onboarding', () => void doAction('reset-onboarding').then(ok => ok && (showToast('Onboarding reset'), void load())))} disabled={actionLoading}
                className={`${btnBase} ${confirmAction === 'reset-onboarding' ? 'border-red-500 bg-red-500 text-white' : btnOrange.split(' ').slice(1).join(' ')}`}>
                <RotateCcw className="w-4 h-4" /> {confirmAction === 'reset-onboarding' ? 'Click to confirm' : 'Reset Onboarding'}
              </button>
            </div>
          </div>

          <div className="flex gap-1 mb-5 border-b border-gray-200 dark:border-gray-700">
            {(['profile', 'companies', 'audit'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${activeTab === tab ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}>
                {tab}
              </button>
            ))}
          </div>

          {activeTab === 'profile' && (
            <UserProfileForm
              user={user}
              editing={editing}
              editState={editState}
              actionLoading={actionLoading}
              onSave={() => void handleSaveEdit()}
              onCancel={() => setEditing(false)}
              onEditChange={patch => setEditState(s => ({ ...s, ...patch }))}
            />
          )}
          {activeTab === 'companies' && (
            <UserCompaniesTable
              companies={user.companies}
              allCompanies={allCompanies}
              actionLoading={actionLoading}
              onLink={handleLinkCompany}
              onDelink={handleDelinkCompany}
            />
          )}
          {activeTab === 'audit' && typeof id === 'string' && <UserAuditLog userId={id} />}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg bg-teal-600 text-white text-sm font-medium shadow-lg animate-[fadeIn_0.2s_ease-out]">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {toast}
        </div>
      )}
    </AdminLayout>
  );
}
