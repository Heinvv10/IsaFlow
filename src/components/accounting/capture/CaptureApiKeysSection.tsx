/**
 * CaptureApiKeysSection — API key management for the capture module.
 * Used by pages/accounting/capture/settings.tsx.
 */

import { useState, useEffect, useCallback } from 'react';
import { Key, Copy, Check, Loader2, AlertCircle, X, ShieldOff, Plus } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface ApiKey {
  id: string;
  label: string;
  key_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

interface NewKeyResult {
  key: string;
  id: string;
  label: string;
  prefix: string;
}

interface Props {
  showToast: (msg: string, ok: boolean) => void;
}

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

export function CaptureApiKeysSection({ showToast }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<NewKeyResult | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/capture/api-keys');
      const json = await res.json() as { data?: ApiKey[]; error?: string };
      if (!res.ok) {
        showToast(json.error ?? 'Failed to load API keys', false);
        return;
      }
      setKeys(json.data ?? []);
    } catch {
      showToast('Network error loading API keys', false);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void loadKeys(); }, [loadKeys]);

  async function handleGenerate() {
    const label = newLabel.trim();
    if (!label) { showToast('Enter a label for the key', false); return; }
    setGenerating(true);
    try {
      const res = await apiFetch('/api/accounting/capture/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const json = await res.json() as { data?: NewKeyResult; error?: string };
      if (!res.ok) { showToast(json.error ?? 'Failed to generate key', false); return; }
      setNewKey(json.data ?? null);
      setNewLabel('');
      void loadKeys();
    } catch {
      showToast('Network error', false);
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke(id: string) {
    setRevoking(id);
    try {
      const res = await apiFetch(`/api/accounting/capture/api-keys/${id}/revoke`, {
        method: 'POST',
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) { showToast(json.error ?? 'Failed to revoke key', false); return; }
      showToast('API key revoked', true);
      void loadKeys();
    } catch {
      showToast('Network error', false);
    } finally {
      setRevoking(null);
    }
  }

  async function handleCopyKey() {
    if (!newKey?.key) return;
    await navigator.clipboard.writeText(newKey.key);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  }

  return (
    <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6">
      <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-1 flex items-center gap-2">
        <Key className="h-4 w-4 text-teal-400" />
        API Keys
      </h2>
      <p className="text-sm text-slate-400 mb-5">
        Allow external apps (e.g. FibreFlow) to POST receipts directly to this company&apos;s capture inbox using a bearer token.
      </p>

      {/* One-time key display */}
      {newKey && (
        <div className="mb-5 p-4 rounded-lg bg-amber-900/30 border border-amber-700/50">
          <div className="flex items-start gap-2 mb-2">
            <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-sm font-medium text-amber-300">
              Copy this key now — it won&apos;t be shown again
            </p>
          </div>
          <div className="flex items-center gap-2 mt-2 p-2.5 rounded bg-black/40 border border-amber-800/40">
            <span className="flex-1 font-mono text-xs text-amber-200 break-all select-all">{newKey.key}</span>
            <button
              onClick={handleCopyKey}
              className="shrink-0 p-1.5 rounded text-amber-500 hover:text-amber-300 transition-colors"
              title="Copy key"
            >
              {keyCopied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-slate-500">Label: <span className="text-slate-400">{newKey.label}</span></p>
            <button
              onClick={() => setNewKey(null)}
              className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1"
            >
              <X className="h-3 w-3" /> Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Generate new key */}
      <div className="flex gap-2 mb-5">
        <input
          type="text"
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleGenerate(); }}
          placeholder="Key label, e.g. FibreFlow PWA"
          maxLength={100}
          className="flex-1 px-3 py-2 rounded-lg text-sm bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-teal-500/50"
        />
        <button
          onClick={handleGenerate}
          disabled={generating || !newLabel.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-teal-700 hover:bg-teal-600 disabled:opacity-50 text-white transition-colors"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Generate
        </button>
      </div>

      {/* Keys table */}
      {loading ? (
        <div className="flex items-center gap-2 text-slate-500 py-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading keys…</span>
        </div>
      ) : keys.length === 0 ? (
        <p className="text-sm text-slate-500 py-2">No API keys yet. Generate one above to get started.</p>
      ) : (
        <div className="rounded-lg overflow-hidden border border-[rgba(255,255,255,0.06)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-white/5 border-b border-[rgba(255,255,255,0.06)]">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Label</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Prefix</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Last used</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-[rgba(255,255,255,0.04)] last:border-0">
                  <td className="px-4 py-3 text-slate-200">{k.label}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">{k.key_prefix}…</td>
                  <td className="px-4 py-3 text-slate-400">{formatDate(k.last_used_at)}</td>
                  <td className="px-4 py-3">
                    {k.is_active ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-teal-900/50 text-teal-400 border border-teal-800">Active</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-500 border border-slate-700">Revoked</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {k.is_active && (
                      <button
                        onClick={() => void handleRevoke(k.id)}
                        disabled={revoking === k.id}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 disabled:opacity-50 transition-colors ml-auto"
                        title="Revoke key"
                      >
                        {revoking === k.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldOff className="h-3.5 w-3.5" />
                        )}
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
