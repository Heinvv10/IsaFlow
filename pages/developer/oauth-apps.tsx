/**
 * /developer/oauth-apps — register and manage your OAuth apps.
 * client_secret is shown once at creation; afterwards only the prefix is
 * displayed. Owner-scoped via the API.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  AlertCircle, Check, Copy, Loader2, Plus, Settings, Trash2, X,
} from 'lucide-react';

interface OauthApp {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  redirectUris: string[];
  clientId: string;
  clientSecretPrefix: string;
  isVerified: boolean;
  isFirstParty: boolean;
  createdAt: string;
}

interface NewApp {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

function fmt(val: string | null): string {
  if (!val) return '—';
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

export default function OauthAppsPage() {
  const [apps, setApps] = useState<OauthApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [redirectUris, setRedirectUris] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [newApp, setNewApp] = useState<NewApp | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/developer/oauth-apps');
      const json = (await res.json()) as { data?: OauthApp[]; error?: { message?: string } };
      if (!res.ok) { showToast(json.error?.message ?? 'Failed to load apps', false); return; }
      setApps(json.data ?? []);
    } catch {
      showToast('Network error', false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate() {
    const cleanName = name.trim();
    const uris = redirectUris.split(/\n+/).map((u) => u.trim()).filter(Boolean);
    if (!cleanName) return showToast('Name is required', false);
    if (uris.length === 0) return showToast('At least one redirect URI is required', false);

    setCreating(true);
    try {
      const res = await apiFetch('/api/developer/oauth-apps', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanName,
          description: description.trim() || null,
          logoUrl: logoUrl.trim() || null,
          homepageUrl: homepageUrl.trim() || null,
          redirectUris: uris,
        }),
      });
      const json = (await res.json()) as { data?: NewApp; error?: { message?: string } };
      if (!res.ok || !json.data) {
        showToast(json.error?.message ?? 'Failed to register app', false);
        return;
      }
      setNewApp(json.data);
      setName(''); setDescription(''); setLogoUrl(''); setHomepageUrl(''); setRedirectUris('');
      setShowForm(false);
      void load();
    } catch {
      showToast('Network error', false);
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string, appName: string) {
    if (!confirm(`Revoke "${appName}"? All access tokens for this app stop working immediately and cannot be re-issued.`)) return;
    setRevoking(id);
    try {
      const res = await apiFetch(`/api/developer/oauth-apps/${id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) { showToast(json.error?.message ?? 'Failed to revoke', false); return; }
      showToast('App revoked', true);
      void load();
    } catch {
      showToast('Network error', false);
    } finally {
      setRevoking(null);
    }
  }

  async function copySecret() {
    if (!newApp?.clientSecret) return;
    try {
      await navigator.clipboard.writeText(newApp.clientSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      showToast('Copy failed — please select and copy the secret manually', false);
    }
  }

  return (
    <AppLayout>
      {toast && <Toast msg={toast.msg} ok={toast.ok} onClose={() => setToast(null)} />}

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
              <Settings className="h-6 w-6 text-teal-400" /> OAuth Apps
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              Register OAuth 2.0 client apps to integrate with ISAFlow on behalf of users.
              Each app gets a <code className="text-xs">client_id</code> and{' '}
              <code className="text-xs">client_secret</code> for the auth-code+PKCE flow.
            </p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="shrink-0 px-3 py-2 rounded-lg text-sm font-medium bg-teal-700 hover:bg-teal-600 text-white flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" /> Register app
          </button>
        </div>

        {newApp && (
          <div className="p-4 rounded-lg bg-amber-900/30 border border-amber-700/50">
            <div className="flex items-start gap-2 mb-2">
              <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-sm font-medium text-amber-300">Copy your client secret now — it won&apos;t be shown again.</p>
            </div>
            <div className="space-y-2 mt-3">
              <div className="text-xs text-slate-400">App: <span className="text-slate-200 font-medium">{newApp.name}</span></div>
              <div>
                <div className="text-xs text-slate-500 mb-0.5">Client ID</div>
                <div className="font-mono text-xs text-amber-200 break-all p-2 rounded bg-black/40 border border-amber-800/40 select-all">{newApp.clientId}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-0.5">Client Secret (one-time display)</div>
                <div className="flex items-center gap-2 p-2 rounded bg-black/40 border border-amber-800/40">
                  <span className="flex-1 font-mono text-xs text-amber-200 break-all select-all">{newApp.clientSecret}</span>
                  <button onClick={copySecret} className="shrink-0 p-1.5 rounded text-amber-500 hover:text-amber-300" title="Copy secret">
                    {secretCopied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-3 text-xs">
              <button onClick={() => setNewApp(null)} className="text-slate-500 hover:text-slate-300 flex items-center gap-1">
                <X className="h-3 w-3" /> Dismiss
              </button>
            </div>
          </div>
        )}

        {showForm && (
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6 space-y-4">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Register a new app</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">App name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hubdoc" maxLength={80}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Homepage URL</label>
                <input value={homepageUrl} onChange={(e) => setHomepageUrl(e.target.value)} placeholder="https://your-app.com"
                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Logo URL</label>
              <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://your-app.com/logo.png"
                className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Description</label>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2}
                placeholder="Shown to users on the consent screen."
                className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                Redirect URIs (one per line; https only, except localhost)
              </label>
              <textarea value={redirectUris} onChange={(e) => setRedirectUris(e.target.value)} rows={3}
                placeholder={"https://your-app.com/oauth/callback\nhttp://localhost:3000/callback"}
                className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 font-mono" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowForm(false)} disabled={creating}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                Cancel
              </button>
              <button onClick={() => void handleCreate()} disabled={creating || !name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-teal-700 hover:bg-teal-600 text-white disabled:opacity-50 flex items-center gap-2">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create app
              </button>
            </div>
          </div>
        )}

        <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6">
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Your apps</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 py-3">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : apps.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">No apps registered yet. Click &quot;Register app&quot; to get started.</p>
          ) : (
            <ul className="divide-y divide-[rgba(255,255,255,0.06)]">
              {apps.map((a) => (
                <li key={a.id} className="py-3 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-slate-100">{a.name}</h3>
                    <div className="text-xs text-slate-500 mt-1 space-y-0.5">
                      <div>Client ID: <code className="font-mono text-slate-400">{a.clientId}</code></div>
                      <div>Secret: <code className="font-mono text-slate-400">{a.clientSecretPrefix}…</code></div>
                      <div>Redirect URIs: <code className="font-mono text-slate-400">{a.redirectUris.join(', ')}</code></div>
                      <div>Created: {fmt(a.createdAt)}</div>
                    </div>
                  </div>
                  <button onClick={() => void handleRevoke(a.id, a.name)} disabled={revoking === a.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 disabled:opacity-50">
                    {revoking === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
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
