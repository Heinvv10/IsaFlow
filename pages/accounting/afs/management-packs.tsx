// pages/accounting/afs/management-packs.tsx
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  Settings, History, Plus, Send, Eye, AlertCircle, CheckCircle,
  Clock, Loader2, BarChart3,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ManagementPackConfigTab } from '@/components/accounting/management-packs/ManagementPackConfigTab';
import type { ManagementPackConfig } from '@/modules/accounting/services/afs/afsTypes';

type PackDoc = {
  id: string;
  period: string;
  status: string;
  created_at: string;
  updated_at: string;
};

const STATUS_CONFIG: Record<string, { label: string; colour: string; icon: React.ReactNode }> = {
  draft:          { label: 'Draft',      colour: 'bg-zinc-100 text-zinc-700',     icon: <Clock className="w-3 h-3" /> },
  in_review:      { label: 'In Review',  colour: 'bg-blue-100 text-blue-700',     icon: <Clock className="w-3 h-3" /> },
  partner_review: { label: 'Reviewing',  colour: 'bg-yellow-100 text-yellow-700', icon: <Clock className="w-3 h-3" /> },
  signed_off:     { label: 'Signed Off', colour: 'bg-green-100 text-green-700',   icon: <CheckCircle className="w-3 h-3" /> },
  filed:          { label: 'Filed',      colour: 'bg-purple-100 text-purple-700', icon: <CheckCircle className="w-3 h-3" /> },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? { label: status, colour: 'bg-zinc-100 text-zinc-700', icon: null };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.colour}`}>
      {cfg.icon}{cfg.label}
    </span>
  );
}

export default function ManagementPacksPage() {
  const [tab, setTab] = useState<'config' | 'history'>('config');
  const [config, setConfig] = useState<ManagementPackConfig | null>(null);
  const [packs, setPacks] = useState<PackDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genPeriod, setGenPeriod] = useState('');
  const [deliveringId, setDeliveringId] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [cfgRes, packsRes] = await Promise.all([
        apiFetch('/api/accounting/afs/management-pack-config', { credentials: 'include' }),
        apiFetch('/api/accounting/afs/management-packs', { credentials: 'include' }),
      ]);
      const cfgJson = await cfgRes.json() as { data?: { config?: ManagementPackConfig }; error?: { message?: string } };
      const packsJson = await packsRes.json() as { data?: { documents?: PackDoc[] }; error?: { message?: string } };
      if (!cfgRes.ok) throw new Error(cfgJson.error?.message ?? 'Failed to load config');
      if (!packsRes.ok) throw new Error(packsJson.error?.message ?? 'Failed to load packs');
      setConfig(cfgJson.data?.config ?? null);
      setPacks(packsJson.data?.documents ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : 'Load failed'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleSaveConfig(updated: ManagementPackConfig) {
    const res = await apiFetch('/api/accounting/afs/management-pack-config', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
    const json = await res.json() as { data?: { config?: ManagementPackConfig }; error?: { message?: string } };
    if (!res.ok) throw new Error(json.error?.message ?? 'Save failed');
    setConfig(json.data?.config ?? updated);
  }

  async function handleGenerate() {
    if (!genPeriod || !/^\d{4}-\d{2}$/.test(genPeriod)) return;
    setGenerating(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/afs/generate-pack', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: genPeriod }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: { message?: string } };
        throw new Error(j.error?.message ?? 'Generate failed');
      }
      await load();
      setGenPeriod('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Generate failed'); }
    finally { setGenerating(false); }
  }

  async function handleDeliver(packId: string) {
    setDeliveringId(packId); setError('');
    try {
      const res = await apiFetch(`/api/accounting/afs/management-packs/${packId}/deliver`, {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) {
        const j = await res.json() as { error?: { message?: string } };
        throw new Error(j.error?.message ?? 'Deliver failed');
      }
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Deliver failed'); }
    finally { setDeliveringId(''); }
  }

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">Management Packs</h1>
            <p className="text-sm text-zinc-500 mt-1">Automated monthly management accounts</p>
          </div>
          <div className="flex items-center gap-2">
            <input value={genPeriod} onChange={e => setGenPeriod(e.target.value)}
              placeholder="YYYY-MM" className="border border-zinc-200 rounded-lg px-3 py-2 text-sm w-28" />
            <button onClick={handleGenerate} disabled={generating || !genPeriod}
              className="inline-flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white text-sm font-semibold rounded-lg hover:bg-zinc-700 disabled:opacity-50">
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Generate
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </div>
        )}

        <div className="flex gap-1 mb-6 border-b border-zinc-200">
          {[
            { key: 'config', label: 'Configuration', icon: <Settings className="w-4 h-4" /> },
            { key: 'history', label: 'Pack History', icon: <History className="w-4 h-4" /> },
          ].map(t => (
            <button key={t.key} onClick={() => setTab(t.key as 'config' | 'history')}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === t.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-zinc-500 hover:text-zinc-900'}`}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-400">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading…
          </div>
        ) : tab === 'config' ? (
          config
            ? <ManagementPackConfigTab config={config} onSave={handleSaveConfig} />
            : <p className="text-sm text-zinc-500">No config loaded.</p>
        ) : (
          <div className="space-y-3">
            {packs.length === 0 ? (
              <div className="text-center py-20 text-zinc-400">
                <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm">No management packs generated yet.</p>
              </div>
            ) : packs.map(pack => (
              <div key={pack.id} className="bg-white border border-zinc-200 rounded-xl p-5 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-base font-semibold text-zinc-900">{pack.period}</span>
                    <StatusBadge status={pack.status} />
                  </div>
                  <p className="text-xs text-zinc-500">
                    Created {new Date(pack.created_at).toLocaleDateString('en-ZA')}
                    {' · '}Updated {new Date(pack.updated_at).toLocaleDateString('en-ZA')}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <a href={`/accounting/afs/${pack.id}`}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-zinc-200 rounded-lg text-zinc-700 hover:bg-zinc-50">
                    <Eye className="w-3.5 h-3.5" /> View
                  </a>
                  {(pack.status === 'draft' || pack.status === 'signed_off') && (
                    <button onClick={() => handleDeliver(pack.id)} disabled={deliveringId === pack.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                      {deliveringId === pack.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      Deliver
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
