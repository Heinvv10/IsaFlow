/**
 * /accounting/settings/connected-apps — manage OAuth integrations.
 * List apps the current user has authorised for the active company; revoke
 * with one click.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Plug, ShieldCheck, Loader2, ShieldOff, X } from 'lucide-react';

interface ConnectedApp {
  authorisationId: string;
  appId: string;
  appName: string;
  appLogoUrl: string | null;
  appIsVerified: boolean;
  scopes: string[];
  companyId: string;
  lastUsedAt: string | null;
  createdAt: string;
}

function fmt(val: string | null): string {
  if (!val) return 'Never';
  try {
    return new Date(val).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return val; }
}

function Toast({ msg, ok, onClose }: { msg: string; ok: boolean; onClose: () => void }) {
  return (
    <div role="alert" className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg shadow-lg border flex items-start gap-2 ${
      ok ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100' : 'bg-red-900/90 border-red-700 text-red-100'
    }`}>
      <span className="flex-1 text-sm">{msg}</span>
      <button onClick={onClose} className="opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
    </div>
  );
}

export default function ConnectedAppsPage() {
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/oauth/connected-apps');
      const json = (await res.json()) as { data?: ConnectedApp[]; error?: { message?: string } };
      if (!res.ok) {
        showToast(json.error?.message ?? 'Failed to load connected apps', false);
        return;
      }
      setApps(json.data ?? []);
    } catch {
      showToast('Network error', false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleRevoke(authorisationId: string, name: string) {
    if (!confirm(`Revoke access for ${name}? They'll need to ask you to authorise again.`)) return;
    setRevoking(authorisationId);
    try {
      const res = await apiFetch(`/api/oauth/authorisations/${authorisationId}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) { showToast(json.error?.message ?? 'Failed to revoke', false); return; }
      showToast('Access revoked', true);
      void load();
    } catch {
      showToast('Network error', false);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <AppLayout>
      {toast && <Toast msg={toast.msg} ok={toast.ok} onClose={() => setToast(null)} />}

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
            <Plug className="h-6 w-6 text-teal-400" /> Connected Apps
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Apps you&apos;ve authorised to access ISAFlow on your behalf for this company.
            Revoke access at any time — the app&apos;s tokens stop working immediately.
          </p>
        </div>

        <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 py-3">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : apps.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">
              No connected apps yet. Apps that integrate with ISAFlow will appear here after you authorise them.
            </p>
          ) : (
            <ul className="divide-y divide-[rgba(255,255,255,0.06)]">
              {apps.map((a) => (
                <li key={a.authorisationId} className="py-4 flex items-start gap-4">
                  <div className="h-12 w-12 rounded-lg bg-slate-800 ring-1 ring-slate-700 shrink-0 flex items-center justify-center text-slate-400 font-semibold">
                    {a.appLogoUrl ? (
                      <img src={a.appLogoUrl} alt={a.appName} className="h-full w-full object-cover rounded-lg" />
                    ) : (
                      a.appName.slice(0, 1).toUpperCase()
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-100">{a.appName}</h3>
                      {a.appIsVerified && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-teal-900/60 text-teal-300 border border-teal-800/60 flex items-center gap-1">
                          <ShieldCheck className="h-3 w-3" /> Verified
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      Connected {fmt(a.createdAt)} · Last used {fmt(a.lastUsedAt)}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      Scopes: <span className="font-mono">{a.scopes.join(', ')}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => void handleRevoke(a.authorisationId, a.appName)}
                    disabled={revoking === a.authorisationId}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 disabled:opacity-50 transition shrink-0"
                  >
                    {revoking === a.authorisationId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
