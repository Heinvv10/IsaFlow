/**
 * Bureau Clients — manage which companies belong to the bureau.
 *
 * Owner can link/unlink any company they have access to. Members can view
 * the roster but the link/unlink controls are disabled.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import {
  Briefcase, AlertCircle, Loader2, Building2, Plus, Trash2, ArrowLeft,
} from 'lucide-react';

interface BureauRef {
  id: string;
  name: string;
  ownerUserId: string;
  role: 'owner' | 'accountant' | 'viewer';
}

interface BureauClient {
  bureauId: string;
  companyId: string;
  companyName: string;
  addedAt: string;
}

interface DashboardData {
  bureaus: BureauRef[];
}

export default function BureauClientsPage() {
  const { companies: userCompanies } = useCompany();
  const [bureaus, setBureaus] = useState<BureauRef[]>([]);
  const [activeBureauId, setActiveBureauId] = useState<string | null>(null);
  const [clients, setClients] = useState<BureauClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const activeBureau = bureaus.find((b) => b.id === activeBureauId) ?? null;
  const isOwner = activeBureau?.role === 'owner';

  const loadBureaus = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/bureau');
      const json = await res.json() as { data?: DashboardData; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      const list = json.data?.bureaus ?? [];
      setBureaus(list);
      if (list.length > 0 && !activeBureauId) setActiveBureauId(list[0]!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [activeBureauId]);

  const loadClients = useCallback(async (bureauId: string) => {
    try {
      const res = await apiFetch(`/api/bureau/clients?bureauId=${bureauId}`);
      const json = await res.json() as { data?: { companies: BureauClient[] }; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load clients');
      setClients(json.data?.companies ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load clients');
    }
  }, []);

  useEffect(() => { void loadBureaus(); }, [loadBureaus]);
  useEffect(() => { if (activeBureauId) void loadClients(activeBureauId); }, [activeBureauId, loadClients]);

  const link = async (companyId: string) => {
    if (!activeBureauId) return;
    setWorking(true); setError('');
    try {
      const res = await apiFetch('/api/bureau/clients', {
        method: 'POST',
        body: JSON.stringify({ bureauId: activeBureauId, companyId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || 'Failed to link');
      }
      await loadClients(activeBureauId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link');
    } finally {
      setWorking(false);
    }
  };

  const unlink = async (companyId: string) => {
    if (!activeBureauId) return;
    if (!confirm('Remove this client from the bureau? The company is not deleted.')) return;
    setWorking(true); setError('');
    try {
      const res = await apiFetch('/api/bureau/clients', {
        method: 'DELETE',
        body: JSON.stringify({ bureauId: activeBureauId, companyId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || 'Failed to unlink');
      }
      await loadClients(activeBureauId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlink');
    } finally {
      setWorking(false);
    }
  };

  // Companies the user could add — minus those already linked.
  const linkedIds = new Set(clients.map((c) => c.companyId));
  const linkable = (userCompanies ?? []).filter((c) => !linkedIds.has(c.companyId));

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
      </AppLayout>
    );
  }

  if (bureaus.length === 0) {
    return (
      <AppLayout>
        <div className="p-6">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm">
            <AlertCircle className="h-4 w-4" /> You aren&apos;t a member of any bureau.
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/bureau" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Briefcase className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Manage Clients</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Link companies to a bureau so they show up in the dashboard.</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {bureaus.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              {bureaus.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setActiveBureauId(b.id)}
                  className={`px-3 py-1.5 rounded-full text-xs ${activeBureauId === b.id ? 'bg-purple-500/20 text-purple-400' : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]'}`}
                >
                  {b.name} <span className="opacity-60">({b.role})</span>
                </button>
              ))}
            </div>
          )}

          {/* Linked clients */}
          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
              <h2 className="text-sm font-medium text-[var(--ff-text-primary)]">Linked clients ({clients.length})</h2>
            </div>
            {clients.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-[var(--ff-text-tertiary)]">No clients linked yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Company</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Linked</th>
                    <th className="py-2 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.companyId} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-2 px-4">
                        <Link
                          href={`/bureau/clients/${c.companyId}`}
                          className="inline-flex items-center gap-2 text-[var(--ff-text-primary)] hover:text-teal-400"
                        >
                          <Building2 className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                          {c.companyName}
                        </Link>
                      </td>
                      <td className="py-2 px-4 text-[var(--ff-text-secondary)] text-xs">{new Date(c.addedAt).toLocaleDateString()}</td>
                      <td className="py-2 px-4 text-right">
                        {isOwner && (
                          <button
                            onClick={() => void unlink(c.companyId)}
                            disabled={working}
                            className="text-xs text-red-400 hover:text-red-500 disabled:opacity-50 inline-flex items-center gap-1"
                          >
                            <Trash2 className="h-3 w-3" /> Unlink
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Linkable companies — only owner sees this */}
          {isOwner && (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-primary)]">
                <h2 className="text-sm font-medium text-[var(--ff-text-primary)]">Available to link</h2>
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">Companies you can access that aren&apos;t linked to this bureau yet.</p>
              </div>
              {linkable.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--ff-text-tertiary)]">
                  Every company you can access is already linked.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {linkable.map((c) => (
                      <tr key={c.companyId} className="border-b border-[var(--ff-border-primary)] last:border-0">
                        <td className="py-2 px-4 text-[var(--ff-text-primary)] flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
                          {c.companyName}
                        </td>
                        <td className="py-2 px-4 text-right">
                          <button
                            onClick={() => void link(c.companyId)}
                            disabled={working}
                            className="text-xs text-teal-400 hover:text-teal-500 disabled:opacity-50 inline-flex items-center gap-1"
                          >
                            <Plus className="h-3 w-3" /> Link to bureau
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
