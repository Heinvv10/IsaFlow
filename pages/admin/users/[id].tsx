/**
 * Admin — User Detail
 * Profile, company memberships, audit log, and admin actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiJson, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { useAdminHref, tenantAppUrl } from '@/hooks/useAdminPrefix';
import { ArrowLeft, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { UserCompaniesTable, type UserCompany, type CompanyOption } from '@/components/admin/users/UserCompaniesTable';
import { UserAuditLog } from '@/components/admin/users/UserAuditLog';
import { UserProfileForm } from '@/components/admin/users/UserProfileForm';
import { LoginAsModal } from '@/components/admin/users/LoginAsModal';
import { UserActionBar, type UserBureau } from '@/components/admin/users/UserActionBar';
import { log } from '@/lib/logger';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import { adminFetch } from '@/lib/admin/adminFetch';

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
  account_type: 'direct' | 'bureau_owner' | 'bureau_member';
  bureaus: UserBureau[];
}

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
  const [confirmAction, setConfirmAction]         = useState<string | null>(null);
  const [toast, setToast]                         = useState<string | null>(null);
  const [loginAsModalOpen, setLoginAsModalOpen]   = useState(false);
  const [loginAsRedirect, setLoginAsRedirect]     = useState<string | null>(null);
  const afterToast = useTimeoutOnce();
  const afterConfirm = useTimeoutOnce();

  function showToast(msg: string) {
    setToast(msg);
    afterToast(() => setToast(null), 3000);
  }

  const load = useCallback(async () => {
    if (!id || typeof id !== 'string') return;
    setLoading(true); setError('');
    try {
      const res  = await adminFetch(`/api/admin/users/${id}`);
      await assertOk(res, 'Could not load this user - try again');
      const json = await res.json();
      const u = json.data as UserDetail;
      setUser(u);
      setEditState({ firstName: u.first_name, lastName: u.last_name, phone: u.phone ?? '', role: u.role });
    } catch (err) {
      log.error('AdminUserDetail load failed', { userId: id, error: err }, 'admin-ui');
      setError(apiErrorMessage(err, 'Could not load this user - try again'));
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const res  = await adminFetch('/api/admin/companies?limit=100');
        await assertOk(res, 'Could not load the company list');
        const json = await res.json();
        setAllCompanies((json.data?.items ?? []) as CompanyOption[]);
      } catch (err) { log.error('Failed to load companies', { error: err }, 'admin-ui'); }
    })();
  }, []);

  /** null on failure (shown); on success, the server's `message` when it sent one (e.g. a suspension's warning). */
  async function doAction(endpoint: string, method = 'POST', body?: object): Promise<{ message?: string } | null> {
    if (!id || typeof id !== 'string') return null;
    setActionLoading(true); setActionError('');
    try {
      const url = endpoint ? `/api/admin/users/${id}/${endpoint}` : `/api/admin/users/${id}`;
      const res  = await adminFetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      await assertOk(res, 'Could not update the user - try again');
      const text = await res.text();
      let message: string | undefined;
      try { const m = (JSON.parse(text) as { message?: unknown }).message; message = typeof m === 'string' ? m : undefined; }
      catch { message = undefined; /* a success without a JSON body carries no message */ }
      return { message };
    } catch (err) {
      setActionError(apiErrorMessage(err, 'Could not update the user - try again'));
      return null;
    } finally { setActionLoading(false); }
  }

  function confirmAndRun(key: string, action: () => void) {
    if (confirmAction === key) { setConfirmAction(null); action(); }
    else { setConfirmAction(key); afterConfirm(() => setConfirmAction(prev => prev === key ? null : prev), 3000); }
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
      const res  = await adminFetch(`/api/admin/companies/${defaultCompany.company_id}/impersonate`, { method: 'POST' });
      await assertOk(res, 'Could not start impersonation - try again');
      const json = await res.json();
      const token = (json.data as { token: string }).token;
      window.open(tenantAppUrl(`/accounting?impersonate=${encodeURIComponent(token)}`), '_blank', 'noopener,noreferrer');
      showToast('Impersonation session opened');
    } catch (err) {
      log.error('Impersonation failed', { userId: user.id, error: err }, 'admin-ui');
      setActionError(apiErrorMessage(err, 'Could not start impersonation - try again'));
    } finally { setActionLoading(false); }
  }

  async function handleLoginAs() {
    if (!user || !id || typeof id !== 'string') return;
    setActionLoading(true); setActionError('');
    try {
      // Impersonation is cookie-based: this call sets the stash cookies on the
      // shared parent domain and returns only where to go. It never returns a
      // token — reading one here made the UI report failure after the session
      // had already been created server-side.
      const { redirect } = await apiJson(`/api/admin/users/${id}/impersonate`, {
        method:  'POST',
        headers: { 'X-Admin-Request': 'true' },
      }, 'Could not start impersonation - try again');
      setLoginAsRedirect(redirect);
      setLoginAsModalOpen(true);
    } catch (err) {
      log.error('Login-as impersonation failed', { userId: user.id, error: err }, 'admin-ui');
      setActionError(apiErrorMessage(err, 'Could not create impersonation session - try again'));
    } finally { setActionLoading(false); }
  }

  function openImpersonationTab() {
    if (loginAsRedirect === null) return;
    // Defensive: the API hardcodes '/accounting', but the type only promises a
    // string and this opens a tab as another user. Require a same-origin
    // relative path so a future server change cannot turn this into an open
    // redirect. `//evil.com` is rejected — it is protocol-relative, not local.
    const isLocalPath = loginAsRedirect.startsWith('/') && !loginAsRedirect.startsWith('//');
    if (!isLocalPath) {
      log.error('Refusing non-local impersonation redirect', { redirect: loginAsRedirect }, 'admin-ui');
      setActionError('Server returned an unexpected redirect target');
      return;
    }
    window.open(tenantAppUrl(loginAsRedirect), '_blank', 'noopener,noreferrer');
    setLoginAsModalOpen(false);
    showToast('Impersonation session opened in new tab');
  }

  async function handleToggleSuspend() {
    const endpoint = user?.status === 'suspended' ? 'activate' : 'suspend';
    const body     = endpoint === 'suspend' ? { reason: 'Suspended by admin' } : undefined;
    const done = await doAction(endpoint, 'POST', body);
    if (!done) return;
    // A suspension whose browser sessions GoTrue could not revoke says so: shown until dismissed, not as a toast.
    if (done.message) setActionError(done.message);
    else showToast(endpoint === 'activate' ? 'User activated' : 'User suspended');
    void load();
  }

  async function handleLinkCompany(companyId: string, role: string) {
    const ok = await doAction('add-to-company', 'POST', { company_id: companyId, role });
    if (ok) { showToast('Company linked'); void load(); }
  }

  async function handleDelinkCompany(companyId: string) {
    const ok = await doAction('remove-from-company', 'DELETE', { company_id: companyId });
    if (ok) { showToast('Company removed'); void load(); }
  }

  async function handleChangeCompanyRole(companyId: string, role: string) {
    const ok = await doAction('company-role', 'PATCH', { company_id: companyId, role });
    if (ok) { showToast('Role updated'); void load(); }
  }

  async function handleConvertToBureau() {
    if (!user) return;
    const suggested = `${user.first_name} ${user.last_name}`.trim() || user.email.split('@')[0]!;
    const bureauName = window.prompt('Bureau / practice name:', suggested);
    if (!bureauName || !bureauName.trim()) return;
    const ok = await doAction('convert-to-bureau', 'POST', { bureauName: bureauName.trim() });
    if (ok) { showToast('User converted to bureau owner'); void load(); }
  }

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
          <UserActionBar
            user={user}
            actionLoading={actionLoading}
            confirmAction={confirmAction}
            onConfirm={confirmAndRun}
            onEdit={() => setEditing(e => !e)}
            onImpersonate={() => void handleImpersonate()}
            onLoginAs={() => {
              if (user.role === 'super_admin') { setActionError('Cannot login as another super_admin'); return; }
              setLoginAsModalOpen(true); setLoginAsRedirect(null);
            }}
            onResetPassword={() => void doAction('reset-password').then(ok => ok && showToast('Password reset sent'))}
            onToggleSuspend={() => void handleToggleSuspend()}
            onForceLogout={() => void doAction('force-logout').then(ok => ok && showToast('All sessions cleared'))}
            onResetOnboarding={() => void doAction('reset-onboarding').then(ok => ok && (showToast('Onboarding reset'), void load()))}
            onConvertToBureau={() => void handleConvertToBureau()}
          />

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
              onChangeRole={handleChangeCompanyRole}
            />
          )}
          {activeTab === 'audit' && typeof id === 'string' && <UserAuditLog userId={id} />}
        </>
      )}

      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg bg-brand-600 text-white text-sm font-medium shadow-lg animate-[fadeIn_0.2s_ease-out]">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> {toast}
        </div>
      )}

      {loginAsModalOpen && user && (
        <LoginAsModal
          user={user}
          redirectUrl={loginAsRedirect}
          loading={actionLoading}
          onConfirm={() => void handleLoginAs()}
          onOpenTab={openImpersonationTab}
          onClose={() => { setLoginAsModalOpen(false); setLoginAsRedirect(null); }}
        />
      )}
    </AdminLayout>
  );
}
