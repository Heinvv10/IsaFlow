/**
 * User Access Control — mirrors Sage Accounting "Control User Access".
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, UserPlus, Trash2, Shield, Mail, Clock, Copy, Check } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useAuth } from '@/contexts/AuthContext';

interface CompanyUser { userId: string; name: string; email: string; role: string; joinedAt: string; }
interface PendingInvitation {
  id: string; email: string; role: string; token: string; expiresAt: string; createdAt: string;
  emailSentAt: string | null; emailError: string | null;
}

const ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
const ADMIN_ROLES = ['owner', 'admin'];
const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-teal-900 text-teal-300', admin: 'bg-blue-900 text-blue-300',
  manager: 'bg-purple-900 text-purple-300', viewer: 'bg-gray-700 text-gray-300',
};

export default function UserAccessPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('viewer');
  const [inviting, setInviting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const myEntry = users.find((u) => u.userId === user?.id);
  const myRole = myEntry?.role ?? '';
  const isAdmin = ADMIN_ROLES.includes(myRole);
  const ownerCount = users.filter((u) => u.role === 'owner').length;

  const loadData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const ur = await (await apiFetch('/api/accounting/company-users')).json();
      setUsers(ur.data ?? []);
      // Always try fetching invitations — the API returns 403 for non-admins which is fine
      try {
        const ir = await (await apiFetch('/api/accounting/company-invitations')).json();
        setInvitations(ir.data ?? []);
      } catch { /* non-admin — no access to invitations */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 4000);
  };

  async function handleRoleChange(userId: string, role: string) {
    try {
      const j = await (await apiFetch('/api/accounting/company-users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, role }) })).json();
      setUsers(j.data ?? []); showFeedback('Role updated.');
    } catch (e) { showFeedback(e instanceof Error ? e.message : 'Update failed.'); }
  }

  async function handleRemove(userId: string) {
    try {
      const j = await (await apiFetch('/api/accounting/company-users', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) })).json();
      setUsers(j.data ?? []); showFeedback('User removed.');
    } catch (e) { showFeedback(e instanceof Error ? e.message : 'Remove failed.'); }
    finally { setConfirmRemove(null); }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const j = await (await apiFetch('/api/accounting/company-invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      })).json();
      if (j.data?.autoAdded) {
        showFeedback(`${inviteEmail} was found and added directly to this company.`);
        loadData();
      } else {
        showFeedback(`Invitation sent to ${inviteEmail}.`);
        const ir = await (await apiFetch('/api/accounting/company-invitations')).json();
        setInvitations(ir.data ?? []);
      }
      setInviteEmail('');
    } catch (e) { showFeedback(e instanceof Error ? e.message : 'Invite failed.'); }
    finally { setInviting(false); }
  }

  async function handleCancelInvite(invitationId: string) {
    try {
      await apiFetch('/api/accounting/company-invitations', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitationId }) });
      setInvitations((prev) => prev.filter((i) => i.id !== invitationId));
      showFeedback('Invitation cancelled.');
    } catch (e) { showFeedback(e instanceof Error ? e.message : 'Cancel failed.'); }
  }

  function handleCopyLink(inv: PendingInvitation) {
    const link = `${window.location.origin}/invite/${inv.token}`;
    void navigator.clipboard.writeText(link).then(() => {
      setCopiedId(inv.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });

  return (
    <AppLayout>
      <div className="min-h-screen bg-gray-950 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl space-y-8">

          <div className="flex items-center gap-3">
            <Shield className="h-7 w-7 text-teal-400" />
            <div>
              <h1 className="text-2xl font-bold text-white">User Access Control</h1>
              <p className="text-sm text-gray-400">Manage who can access this company and what they can do.</p>
            </div>
          </div>

          {feedback && <div className="rounded-lg border border-teal-700 bg-teal-900/40 px-4 py-3 text-sm text-teal-300">{feedback}</div>}
          {error && <div className="rounded-lg border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300">{error}</div>}

          {/* Current Users */}
          <div className="rounded-xl border border-gray-800 bg-gray-900">
            <div className="flex items-center gap-2 border-b border-gray-800 px-6 py-4">
              <Users className="h-5 w-5 text-teal-400" />
              <h2 className="font-semibold text-white">Company Users</h2>
            </div>
            {loading ? (
              <div className="px-6 py-10 text-center text-gray-500">Loading...</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-gray-500">
                      <th className="px-6 py-3 font-medium">Name</th>
                      <th className="px-6 py-3 font-medium">Email</th>
                      <th className="px-6 py-3 font-medium">Role</th>
                      <th className="px-6 py-3 font-medium">Joined</th>
                      {isAdmin && <th className="px-6 py-3 font-medium">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {users.map((u) => {
                      const isSelf = u.userId === user?.id;
                      const isLastOwner = u.role === 'owner' && ownerCount <= 1;
                      return (
                        <tr key={u.userId} className="hover:bg-gray-800/40">
                          <td className="px-6 py-3 text-white">
                            {u.name}{isSelf && <span className="ml-2 text-xs text-gray-500">(you)</span>}
                          </td>
                          <td className="px-6 py-3 text-gray-400">{u.email}</td>
                          <td className="px-6 py-3">
                            {isAdmin && !isSelf ? (
                              <select value={u.role} onChange={(e) => handleRoleChange(u.userId, e.target.value)}
                                className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-white focus:border-teal-500 focus:outline-none">
                                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                              </select>
                            ) : (
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_BADGE[u.role] ?? 'bg-gray-700 text-gray-300'}`}>{u.role}</span>
                            )}
                          </td>
                          <td className="px-6 py-3 text-gray-400">{fmt(u.joinedAt)}</td>
                          {isAdmin && (
                            <td className="px-6 py-3">
                              {!isSelf && !isLastOwner && (
                                confirmRemove === u.userId ? (
                                  <span className="flex items-center gap-2">
                                    <button onClick={() => handleRemove(u.userId)} className="text-xs text-red-400 hover:text-red-300">Confirm</button>
                                    <button onClick={() => setConfirmRemove(null)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
                                  </span>
                                ) : (
                                  <button onClick={() => setConfirmRemove(u.userId)} className="text-gray-500 hover:text-red-400">
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                )
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Invite User (admin/owner only) */}
          {isAdmin && (
            <div className="rounded-xl border border-gray-800 bg-gray-900">
              <div className="flex items-center gap-2 border-b border-gray-800 px-6 py-4">
                <UserPlus className="h-5 w-5 text-teal-400" />
                <h2 className="font-semibold text-white">Invite a User</h2>
              </div>
              <div className="px-6 py-5">
                <form onSubmit={handleInvite} className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[220px]">
                    <label className="mb-1 block text-xs font-medium text-gray-400">Email Address</label>
                    <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="colleague@example.com" required
                      className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-teal-500 focus:outline-none" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-400">Role</label>
                    <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}
                      className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white focus:border-teal-500 focus:outline-none">
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <button type="submit" disabled={inviting}
                    className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-500 disabled:opacity-50">
                    {inviting ? 'Sending...' : 'Invite'}
                  </button>
                </form>
              </div>
              {invitations.length > 0 && (
                <div className="border-t border-gray-800 px-6 py-4">
                  <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">Pending Invitations</p>
                  <ul className="space-y-2">
                    {invitations.map((inv) => (
                      <li key={inv.id} className="flex items-center justify-between rounded-lg border border-gray-700/50 bg-gray-800/40 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Mail className="h-4 w-4 text-gray-500" />
                          <div>
                            <p className="text-sm text-white">{inv.email}</p>
                            <div className="flex items-center gap-2 text-xs text-gray-500">
                              <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${ROLE_BADGE[inv.role] ?? 'bg-gray-700 text-gray-300'}`}>{inv.role}</span>
                              <Clock className="h-3 w-3" />
                              <span>Expires {fmt(inv.expiresAt)}</span>
                              {inv.emailSentAt ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-green-900/50 px-2 py-0.5 text-green-400">
                                  <Mail className="h-3 w-3" />
                                  Email sent
                                </span>
                              ) : inv.emailError ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-red-900/50 px-2 py-0.5 text-red-400" title={inv.emailError}>
                                  <Mail className="h-3 w-3" />
                                  Email failed
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-orange-900/50 px-2 py-0.5 text-orange-400">
                                  <Mail className="h-3 w-3" />
                                  Email pending
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => handleCopyLink(inv)}
                            title="Copy invite link"
                            className="flex items-center gap-1 text-xs text-gray-500 hover:text-teal-400 transition-colors"
                          >
                            {copiedId === inv.id
                              ? <><Check className="h-3.5 w-3.5 text-teal-400" /><span className="text-teal-400">Copied</span></>
                              : <><Copy className="h-3.5 w-3.5" /><span>Copy link</span></>
                            }
                          </button>
                          <button onClick={() => handleCancelInvite(inv.id)} className="text-xs text-gray-500 hover:text-red-400">Cancel</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </AppLayout>
  );
}
