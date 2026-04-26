/**
 * /developer/personal-tokens — PRD-10 Layer 3
 * Mint, list, and revoke Personal Access Tokens for the active company.
 * Mirrors src/components/accounting/capture/CaptureApiKeysSection.tsx UX.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import {
  AlertCircle,
  Check,
  Copy,
  Key,
  Loader2,
  Plus,
  ShieldOff,
  X,
} from 'lucide-react';

interface PatItem {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface NewPat {
  id: string;
  name: string;
  scopes: string[];
  prefix: string;
  token: string;
}

const ALL_SCOPES = [
  { key: 'read:reports', label: 'Read reports', desc: 'Trial balance, income statement, balance sheet, etc.' },
  { key: 'read:invoices', label: 'Read invoices', desc: 'List and view customer/supplier invoices' },
  { key: 'write:invoices', label: 'Write invoices', desc: 'Create, edit, and post invoices' },
  { key: 'read:bank-tx', label: 'Read bank transactions', desc: 'View imported bank statements and allocations' },
  { key: 'write:bank-tx', label: 'Write bank transactions', desc: 'Allocate, edit, and post bank transactions' },
  { key: 'write:journals', label: 'Write journals', desc: 'Post General Ledger journal entries' },
] as const;

const EXPIRY_OPTIONS = [
  { value: 30, label: '30 days' },
  { value: 60, label: '60 days' },
  { value: 90, label: '90 days (default)' },
];

function formatDate(val: string | null): string {
  if (!val) return 'Never';
  try {
    return new Date(val).toLocaleDateString('en-ZA', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return val;
  }
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

function Toast({ msg, ok, onClose }: { msg: string; ok: boolean; onClose: () => void }) {
  return (
    <div
      role="alert"
      className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-lg shadow-lg border flex items-start gap-2 ${
        ok ? 'bg-emerald-900/90 border-emerald-700 text-emerald-100' : 'bg-red-900/90 border-red-700 text-red-100'
      }`}
    >
      <span className="flex-1 text-sm">{msg}</span>
      <button onClick={onClose} className="opacity-70 hover:opacity-100">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export default function PersonalTokensPage() {
  const [tokens, setTokens] = useState<PatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [scopeSet, setScopeSet] = useState<Set<string>>(new Set(['read:reports']));
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [newPat, setNewPat] = useState<NewPat | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/personal-tokens');
      const json = (await res.json()) as { data?: PatItem[]; error?: { message?: string } };
      if (!res.ok) {
        showToast(json.error?.message ?? 'Failed to load tokens', false);
        return;
      }
      setTokens(json.data ?? []);
    } catch {
      showToast('Network error loading tokens', false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleScope = (key: string) => {
    setScopeSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  async function handleGenerate() {
    const trimmed = name.trim();
    if (!trimmed) return showToast('Enter a name for the token', false);
    if (scopeSet.size === 0) return showToast('Select at least one scope', false);

    setGenerating(true);
    try {
      const res = await apiFetch('/api/auth/personal-tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          scopes: Array.from(scopeSet),
          expiresInDays,
        }),
      });
      const json = (await res.json()) as { data?: NewPat; error?: { message?: string } };
      if (!res.ok) {
        showToast(json.error?.message ?? 'Failed to mint token', false);
        return;
      }
      setNewPat(json.data ?? null);
      setName('');
      setScopeSet(new Set(['read:reports']));
      void load();
    } catch {
      showToast('Network error', false);
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevoking(id);
    try {
      const res = await apiFetch(`/api/auth/personal-tokens/${id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        showToast(json.error?.message ?? 'Failed to revoke token', false);
        return;
      }
      showToast('Token revoked', true);
      void load();
    } catch {
      showToast('Network error', false);
    } finally {
      setRevoking(null);
    }
  }

  async function copyToken() {
    if (!newPat?.token) return;
    try {
      await navigator.clipboard.writeText(newPat.token);
      setTokenCopied(true);
      setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      // Permissions denied / non-secure context / unsupported browser. The
      // token is rendered with `select-all` so the user can manually select
      // and copy as a fallback.
      showToast('Copy failed — please select and copy the token manually', false);
    }
  }

  return (
    <AppLayout>
      {toast && <Toast msg={toast.msg} ok={toast.ok} onClose={() => setToast(null)} />}

      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--ff-text-primary)] flex items-center gap-2">
            <Key className="h-6 w-6 text-teal-400" /> Personal Access Tokens
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Use Personal Access Tokens to call the ISAFlow API from scripts, CI, or automation —
            no browser needed. Tokens are tied to your user and the active company.
          </p>
        </div>

        {/* One-time token display */}
        {newPat && (
          <div className="p-4 rounded-lg bg-amber-900/30 border border-amber-700/50">
            <div className="flex items-start gap-2 mb-2">
              <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-sm font-medium text-amber-300">
                Copy this token now — it won&apos;t be shown again.
              </p>
            </div>
            <div className="flex items-center gap-2 mt-2 p-2.5 rounded bg-black/40 border border-amber-800/40">
              <span className="flex-1 font-mono text-xs text-amber-200 break-all select-all">{newPat.token}</span>
              <button
                onClick={copyToken}
                className="shrink-0 p-1.5 rounded text-amber-500 hover:text-amber-300 transition-colors"
                title="Copy token"
              >
                {tokenCopied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex items-center justify-between mt-2 text-xs text-slate-500">
              <span>
                Name: <span className="text-slate-400">{newPat.name}</span> · Scopes:{' '}
                <span className="text-slate-400">{newPat.scopes.join(', ')}</span>
              </span>
              <button
                onClick={() => setNewPat(null)}
                className="hover:text-slate-300 flex items-center gap-1"
              >
                <X className="h-3 w-3" /> Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Mint form */}
        <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Create new token</h2>

          <div>
            <label htmlFor="pat-name" className="block text-xs font-medium text-slate-400 mb-1">
              Token name
            </label>
            <input
              id="pat-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Month-end automation"
              maxLength={80}
              className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-teal-500/50"
            />
          </div>

          <div>
            <span className="block text-xs font-medium text-slate-400 mb-2">Scopes</span>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {ALL_SCOPES.map((s) => (
                <label
                  key={s.key}
                  className="flex items-start gap-2 p-2 rounded border border-[rgba(255,255,255,0.06)] hover:border-teal-500/40 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={scopeSet.has(s.key)}
                    onChange={() => toggleScope(s.key)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-800 text-teal-500 focus:ring-teal-500"
                  />
                  <span className="text-xs">
                    <span className="block text-slate-200 font-medium">{s.label}</span>
                    <span className="block text-slate-500 mt-0.5">{s.desc}</span>
                    <span className="block font-mono text-[10px] text-slate-600 mt-0.5">{s.key}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="pat-expiry" className="block text-xs font-medium text-slate-400 mb-1">
              Expires in
            </label>
            <select
              id="pat-expiry"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              className="px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 focus:outline-none focus:border-teal-500/50"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => void handleGenerate()}
            disabled={generating || !name.trim() || scopeSet.size === 0}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white transition-colors"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create token
          </button>
        </div>

        {/* List */}
        <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6">
          <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Your tokens</h2>
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 py-3">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Loading…</span>
            </div>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">No tokens yet for this company.</p>
          ) : (
            <div className="rounded-lg overflow-hidden border border-[rgba(255,255,255,0.06)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white/5 border-b border-[rgba(255,255,255,0.06)]">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Name</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Prefix</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Scopes</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Last used</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Expires</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => {
                    const expired = isExpired(t.expiresAt);
                    return (
                      <tr key={t.id} className="border-b border-[rgba(255,255,255,0.04)] last:border-0">
                        <td className="px-4 py-3 text-slate-200">{t.name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">{t.prefix}…</td>
                        <td className="px-4 py-3 text-xs text-slate-400">
                          {t.scopes.join(', ')}
                        </td>
                        <td className="px-4 py-3 text-slate-400">{formatDate(t.lastUsedAt)}</td>
                        <td className="px-4 py-3 text-slate-400">
                          {expired ? (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-500 border border-slate-700">
                              Expired
                            </span>
                          ) : (
                            formatDate(t.expiresAt)
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => void handleRevoke(t.id)}
                            disabled={revoking === t.id}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 disabled:opacity-50 transition-colors ml-auto"
                            title="Revoke token"
                          >
                            {revoking === t.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ShieldOff className="h-3.5 w-3.5" />
                            )}
                            Revoke
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
