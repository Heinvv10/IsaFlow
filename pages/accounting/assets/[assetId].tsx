/**
 * Asset Detail Page — view, dispose, and depreciation schedule.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Package, Loader2, AlertCircle, Trash2, Calendar, CheckCircle2, XCircle, BarChart2 } from 'lucide-react';
import { AssetDualTrackPanel } from '@/components/assets/AssetDualTrackPanel';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

// ---- Types ----

interface Asset {
  id: string; asset_number: string; name: string; category: string | null;
  purchase_date: string | Date | null; purchase_price: number | null;
  current_book_value: number | null; useful_life_years: number | null;
  status: string | null; location: string | null; serial_number: string | null;
  supplier_name: string | null; sars_category: string | null; sars_rate: number | null;
  tax_life: number | null; created_at: string | Date;
}

interface DepRow { year: number; open: number; dep: number; close: number; accum: number; }
interface DispForm { disposal_date: string; disposal_method: string; disposal_amount: string; reason: string; }

// ---- Helpers ----

const fmtC = (v: number | null | undefined) =>
  v != null ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(Number(v)) : '—';

const fmtD = (v: string | Date | null | undefined): string => {
  if (!v) return '—';
  return (v instanceof Date ? v.toISOString() : v).split('T')[0] ?? '—';
};

function buildSchedule(a: Asset): DepRow[] {
  const yrs = a.useful_life_years; const cost = Number(a.purchase_price ?? 0);
  if (!yrs || yrs <= 0 || cost <= 0) return [];
  const cap = Math.min(yrs, 30); const ann = cost / yrs;
  let accum = 0;
  return Array.from({ length: cap }, (_, i) => {
    const yr = i + 1; const open = cost - accum;
    const dep = yr < cap ? ann : open;
    accum += dep;
    return { year: yr, open, dep, close: Math.max(0, cost - accum), accum };
  });
}

function currentYear(a: Asset): number {
  if (!a.purchase_date) return -1;
  const ms = Date.now() - new Date(fmtD(a.purchase_date)).getTime();
  return Math.floor(ms / (365.25 * 864e5)) + 1;
}

// ---- Sub-components ----

function DepTable({ asset }: { asset: Asset }) {
  const rows = buildSchedule(asset);
  const cur = currentYear(asset);
  if (!rows.length) return null;
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Straight-Line Depreciation Schedule</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{asset.useful_life_years}-year life · Cost {fmtC(asset.purchase_price)}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] text-xs uppercase">
              <th className="px-4 py-2 text-left">Year</th>
              <th className="px-4 py-2 text-right">Opening</th>
              <th className="px-4 py-2 text-right">Depreciation</th>
              <th className="px-4 py-2 text-right">Closing</th>
              <th className="px-4 py-2 text-right">Accumulated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const hi = r.year === cur;
              return (
                <tr key={r.year} className={`border-b border-[var(--ff-border-light)] ${hi ? 'bg-blue-500/10' : 'hover:bg-[var(--ff-bg-primary)]/40'}`}>
                  <td className={`px-4 py-2 font-medium ${hi ? 'text-blue-400' : 'text-[var(--ff-text-primary)]'}`}>
                    {r.year}{hi && <span className="ml-2 text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full">current</span>}
                  </td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmtC(r.open)}</td>
                  <td className="px-4 py-2 text-right text-purple-400">{fmtC(r.dep)}</td>
                  <td className="px-4 py-2 text-right text-teal-400 font-medium">{fmtC(r.close)}</td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmtC(r.accum)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Main page ----

export default function AssetDetailPage() {
  const router = useRouter();
  const { assetId } = router.query;
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDisposal, setShowDisposal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [disposalError, setDisposalError] = useState('');
  const today = new Date().toISOString().split('T')[0]!;
  const [form, setForm] = useState<DispForm>({ disposal_date: today, disposal_method: 'scrap', disposal_amount: '0', reason: '' });

  const loadAsset = useCallback(async () => {
    if (!assetId || typeof assetId !== 'string') return;
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/assets');
      const json = await res.json() as { data?: unknown };
      const data = json.data ?? json;
      if (Array.isArray(data)) {
        const match = (data as Asset[]).find(a => a.id === assetId) ?? null;
        setAsset(match);
        if (!match) setError('Asset not found');
      } else { setAsset(data as Asset); }
    } catch (err) {
      log.error('Failed to load asset', { err, assetId }, 'accounting');
      setError('Failed to load asset');
    } finally { setLoading(false); }
  }, [assetId]);

  useEffect(() => { void loadAsset(); }, [loadAsset]);

  const handleDispose = async () => {
    if (!asset) return;
    setSubmitting(true); setDisposalError('');
    try {
      const res = await apiFetch('/api/accounting/assets-disposals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id, disposalDate: form.disposal_date, disposalMethod: form.disposal_method, disposalAmount: Number(form.disposal_amount) || 0, reason: form.reason || undefined }),
      });
      const json = await res.json() as { success?: boolean; error?: string; message?: string };
      if (!res.ok || !json.success) { setDisposalError(json.error ?? json.message ?? 'Disposal failed'); return; }
      await router.push('/accounting/assets');
    } catch (err) {
      log.error('Disposal failed', { err, assetId: asset.id }, 'accounting');
      setDisposalError('Network error — please try again');
    } finally { setSubmitting(false); }
  };

  if (loading) return <AppLayout><div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="h-8 w-8 animate-spin text-blue-500" /></div></AppLayout>;
  if (!asset) return (
    <AppLayout>
      <div className="flex items-center justify-center min-h-[60vh] flex-col gap-3">
        <AlertCircle className="h-8 w-8 text-red-400" />
        <p className="text-[var(--ff-text-secondary)]">{error || 'Asset not found'}</p>
        <Link href="/accounting/assets" className="text-sm text-blue-400 hover:text-blue-300">Back to Assets</Link>
      </div>
    </AppLayout>
  );

  const isActive = asset.status?.toLowerCase() === 'active';
  const infoFields = [
    { label: 'Asset Number', value: asset.asset_number, accent: true },
    { label: 'Category', value: asset.category },
    { label: 'Purchase Date', value: fmtD(asset.purchase_date) },
    { label: 'Purchase Price', value: fmtC(asset.purchase_price) },
    { label: 'Current Book Value', value: fmtC(asset.current_book_value), accent: true },
    { label: 'Useful Life', value: asset.useful_life_years ? `${asset.useful_life_years} yrs` : null },
    { label: 'Location', value: asset.location },
    { label: 'Serial Number', value: asset.serial_number },
    { label: 'Supplier', value: asset.supplier_name },
    { label: 'SARS Category', value: asset.sars_category },
    { label: 'SARS Rate', value: asset.sars_rate != null ? `${asset.sars_rate}%` : null },
    { label: 'Tax Life', value: asset.tax_life ? `${asset.tax_life} yrs` : null },
  ] as { label: string; value: string | null; accent?: boolean }[];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/assets" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Assets
          </Link>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><Package className="h-6 w-6 text-blue-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{asset.name}</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{asset.asset_number}</p>
              </div>
              <span className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${isActive ? 'bg-teal-500/20 text-teal-400' : 'bg-gray-500/20 text-gray-400'}`}>
                {isActive ? <CheckCircle2 className="inline h-3 w-3 mr-1" /> : <XCircle className="inline h-3 w-3 mr-1" />}
                {asset.status ?? 'unknown'}
              </span>
            </div>
            {isActive && (
              <button onClick={() => setShowDisposal(v => !v)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 text-sm font-medium transition-colors">
                <Trash2 className="h-4 w-4" /> Dispose Asset
              </button>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {infoFields.map(f => (
              <div key={f.label} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--ff-text-tertiary)] mb-1">{f.label}</p>
                <p className={`text-sm font-semibold truncate ${f.accent ? 'text-blue-400' : 'text-[var(--ff-text-primary)]'}`}>{f.value ?? '—'}</p>
              </div>
            ))}
          </div>

          {showDisposal && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-red-500/40 p-5 space-y-4">
              <div className="flex items-center gap-2"><Trash2 className="h-5 w-5 text-red-400" /><h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Dispose Asset</h2></div>
              {disposalError && <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded px-3 py-2"><AlertCircle className="h-4 w-4 shrink-0" />{disposalError}</div>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Disposal Date</label>
                  <div className="relative"><Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
                    <input type="date" name="disposal_date" value={form.disposal_date} onChange={e => setForm(f => ({ ...f, disposal_date: e.target.value }))} className="ff-input pl-9 w-full" /></div>
                </div>
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Disposal Method</label>
                  <select name="disposal_method" value={form.disposal_method} onChange={e => setForm(f => ({ ...f, disposal_method: e.target.value }))} className="ff-input w-full">
                    {['sale','scrap','write_off','donation','theft','insurance_claim'].map(m => <option key={m} value={m}>{m.replace(/_/g,' ')}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Disposal Amount (ZAR)</label>
                  <input type="number" name="disposal_amount" min="0" step="0.01" value={form.disposal_amount} onChange={e => setForm(f => ({ ...f, disposal_amount: e.target.value }))} className="ff-input w-full" placeholder="0.00" />
                </div>
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Reason / Notes (optional)</label>
                  <textarea name="reason" rows={2} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="ff-input w-full resize-none" placeholder="Additional notes..." />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => void handleDispose()} disabled={submitting} className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors disabled:opacity-50">
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{submitting ? 'Processing…' : 'Confirm Disposal'}
                </button>
                <button onClick={() => { setShowDisposal(false); setDisposalError(''); }} className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">Cancel</button>
              </div>
            </div>
          )}

          <DepTable asset={asset} />

          {/* Dual-track policy vs tax depreciation panel */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--ff-border-light)]">
              <BarChart2 className="h-4 w-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Policy vs Tax Depreciation Track</h2>
            </div>
            <div className="p-4">
              <AssetDualTrackPanel assetId={asset.id} />
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
