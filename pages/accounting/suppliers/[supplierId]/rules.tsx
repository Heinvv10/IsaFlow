/**
 * Per-Supplier Coding Rules — PRD-05 Phase 3
 * Configure default GL account, VAT code, auto-publish gate, and review thresholds.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { ArrowLeft, Loader2, AlertCircle, Check, X, Info } from 'lucide-react';

interface Supplier { id: string; name: string; company_name: string | null }
interface GlAccount { id: string; account_code: string; account_name: string }
interface CostCentre { id: string; code: string; name: string }

interface SupplierRule {
  id: string;
  companyId: string;
  supplierId: string;
  defaultGlAccountId: string | null;
  defaultVatCode: string | null;
  defaultCostCentreId: string | null;
  defaultProjectId: string | null;
  autoPublish: boolean;
  autoPublishMaxAmount: number | null;
  autoPublishMinConfidence: number;
  requirePoMatch: boolean;
  learnedSampleCount: number;
  learnedFromLastCorrectionAt: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

type VatCode = 'STD_RATE' | 'ZERO_RATED' | 'EXEMPT';

function fmtDate(val: string | Date | null): string {
  if (!val) return '—';
  try { return new Date(val).toLocaleString('en-ZA'); } catch { return String(val); }
}

export default function SupplierRulesPage() {
  const router = useRouter();
  const { supplierId } = router.query;
  const sid = typeof supplierId === 'string' ? supplierId : null;

  const [supplier, setSupplier]       = useState<Supplier | null>(null);
  const [rule, setRule]               = useState<SupplierRule | null>(null);
  const [glAccounts, setGlAccounts]   = useState<GlAccount[]>([]);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [deleting, setDeleting]       = useState(false);
  const [error, setError]             = useState('');
  const [toast, setToast]             = useState<{ msg: string; ok: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Form state
  const [glAccountId, setGlAccountId]         = useState('');
  const [vatCode, setVatCode]                 = useState<VatCode | ''>('');
  const [costCentreId, setCostCentreId]       = useState('');
  const [autoPublish, setAutoPublish]         = useState(false);
  const [maxAmount, setMaxAmount]             = useState('');
  const [minConfidence, setMinConfidence]     = useState(95);
  const [glSearch, setGlSearch]               = useState('');
  const [isDirty, setIsDirty]                 = useState(false);

  function showToast(msg: string, ok: boolean) { setToast({ msg, ok }); }
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const loadAll = useCallback(async () => {
    if (!sid) return;
    setLoading(true);
    try {
      const [supRes, ruleRes, glRes, ccRes] = await Promise.all([
        apiFetch(`/api/accounting/suppliers-list?id=${sid}`),
        apiFetch(`/api/accounting/supplier-rules/${sid}`),
        apiFetch('/api/accounting/chart-of-accounts'),
        apiFetch('/api/accounting/cost-centres'),
      ]);

      const supJson = await supRes.json() as { data?: Supplier; success?: boolean };
      if (!supJson.success || !supJson.data) { setError('Supplier not found'); return; }
      setSupplier(supJson.data);

      if (ruleRes.status !== 404) {
        const ruleJson = await ruleRes.json() as { data?: SupplierRule };
        if (ruleJson.data) {
          const r = ruleJson.data;
          setRule(r);
          setGlAccountId(r.defaultGlAccountId ?? '');
          setVatCode((r.defaultVatCode as VatCode) ?? '');
          setCostCentreId(r.defaultCostCentreId ?? '');
          setAutoPublish(r.autoPublish);
          setMaxAmount(r.autoPublishMaxAmount != null ? String(r.autoPublishMaxAmount) : '');
          setMinConfidence(Math.round(r.autoPublishMinConfidence * 100));
        }
      }

      if (glRes.ok) {
        const glJson = await glRes.json() as { data?: GlAccount[] };
        setGlAccounts(glJson.data ?? []);
      }
      if (ccRes.ok) {
        const ccJson = await ccRes.json() as { data?: CostCentre[] };
        setCostCentres(ccJson.data ?? []);
      }
    } catch {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [sid]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  function markDirty() { setIsDirty(true); }

  async function handleSave() {
    if (!sid) return;
    setSaving(true);
    try {
      const body = {
        supplierId: sid,
        defaultGlAccountId: glAccountId || null,
        defaultVatCode: vatCode || null,
        defaultCostCentreId: costCentreId || null,
        autoPublish,
        autoPublishMaxAmount: maxAmount ? parseFloat(maxAmount) : null,
        autoPublishMinConfidence: minConfidence / 100,
        requirePoMatch: rule?.requirePoMatch ?? false,
      };
      const isNew = !rule;
      const res = await apiFetch(
        isNew ? '/api/accounting/supplier-rules' : `/api/accounting/supplier-rules/${sid}`,
        { method: isNew ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      const json = await res.json() as { data?: SupplierRule; error?: string };
      if (!res.ok) { showToast(json.error ?? 'Save failed', false); return; }
      setRule(json.data ?? null);
      setIsDirty(false);
      showToast('Coding rule saved', true);
    } catch {
      showToast('Network error', false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!sid) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/accounting/supplier-rules/${sid}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) { showToast('Delete failed', false); return; }
      void router.push(`/accounting/suppliers/${sid}`);
    } catch {
      showToast('Network error', false);
    } finally {
      setDeleting(false);
    }
  }

  const filteredGl = glAccounts.filter(a =>
    !glSearch ||
    a.account_name.toLowerCase().includes(glSearch.toLowerCase()) ||
    a.account_code.toLowerCase().includes(glSearch.toLowerCase()),
  );

  const promoted = rule?.autoPublish && (rule?.learnedSampleCount ?? 0) >= 5;

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
      </AppLayout>
    );
  }

  if (error || !supplier) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Not found'}</p>
          <Link href="/accounting/suppliers" className="text-sm text-blue-400 hover:text-blue-300">Back to Suppliers</Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href={`/accounting/suppliers/${sid}`}
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to {supplier.name}
          </Link>
          <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Coding Rules</h1>
          <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">{supplier.name}</p>
        </div>

        {/* Toast */}
        {toast && (
          <div className={`mx-6 mt-3 flex items-center justify-between p-3 rounded-lg text-sm ${toast.ok ? 'bg-green-900/40 text-green-300' : 'bg-red-900/40 text-red-300'}`}>
            <span className="flex items-center gap-2">
              {toast.ok ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              {toast.msg}
            </span>
            <button onClick={() => setToast(null)}><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        <div className="p-6 max-w-2xl space-y-6">

          {/* Default Coding */}
          <section className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-4">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Default Coding</h2>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">GL Account</label>
              <input value={glSearch} onChange={e => setGlSearch(e.target.value)} placeholder="Search accounts…"
                className="w-full px-3 py-2 mb-1 rounded bg-white/5 border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm placeholder:text-slate-600 focus:outline-none focus:border-blue-500" />
              <select value={glAccountId} onChange={e => { setGlAccountId(e.target.value); markDirty(); }}
                className="w-full px-3 py-2 rounded bg-white/5 border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-blue-500">
                <option value="">— None —</option>
                {filteredGl.map(a => (
                  <option key={a.id} value={a.id}>{a.account_code} {a.account_name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-2">VAT Code</label>
              <div className="flex gap-4">
                {(['STD_RATE', 'ZERO_RATED', 'EXEMPT'] as VatCode[]).map(v => (
                  <label key={v} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="vatCode" value={v} checked={vatCode === v}
                      onChange={() => { setVatCode(v); markDirty(); }}
                      className="accent-blue-500" />
                    <span className="text-sm text-[var(--ff-text-primary)]">
                      {v === 'STD_RATE' ? 'Standard Rate' : v === 'ZERO_RATED' ? 'Zero Rated' : 'Exempt'}
                    </span>
                  </label>
                ))}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="vatCode" value="" checked={vatCode === ''}
                    onChange={() => { setVatCode(''); markDirty(); }} className="accent-blue-500" />
                  <span className="text-sm text-[var(--ff-text-secondary)]">None</span>
                </label>
              </div>
            </div>

            {costCentres.length > 0 && (
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Cost Centre (optional)</label>
                <select value={costCentreId} onChange={e => { setCostCentreId(e.target.value); markDirty(); }}
                  className="w-full px-3 py-2 rounded bg-white/5 border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-blue-500">
                  <option value="">— None —</option>
                  {costCentres.map(cc => (
                    <option key={cc.id} value={cc.id}>{cc.code} {cc.name}</option>
                  ))}
                </select>
              </div>
            )}
          </section>

          {/* Auto-publish */}
          <section className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-4">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Auto-publish Gate</h2>

            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={autoPublish} onChange={e => { setAutoPublish(e.target.checked); markDirty(); }}
                className="w-4 h-4 accent-teal-500" />
              <span className="text-sm text-[var(--ff-text-primary)]">Enable auto-publish for this supplier</span>
            </label>

            <div className={`space-y-4 ${!autoPublish ? 'opacity-40 pointer-events-none' : ''}`}>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Max amount cap (R) — optional</label>
                <input type="number" min="0" step="0.01" value={maxAmount}
                  onChange={e => { setMaxAmount(e.target.value); markDirty(); }}
                  placeholder="No cap"
                  className="w-full px-3 py-2 rounded bg-white/5 border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-blue-500 placeholder:text-slate-600" />
              </div>

              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-2">
                  Min confidence — {minConfidence}%
                </label>
                <input type="range" min="70" max="100" step="1" value={minConfidence}
                  onChange={e => { setMinConfidence(parseInt(e.target.value)); markDirty(); }}
                  className="w-full accent-blue-500" />
                <div className="flex justify-between text-xs text-[var(--ff-text-tertiary)] mt-1">
                  <span>70%</span><span>100%</span>
                </div>
              </div>
            </div>

            <label className="flex items-center gap-3 cursor-not-allowed opacity-50" title="Enabled in Phase 4">
              <input type="checkbox" disabled className="w-4 h-4" />
              <span className="text-sm text-[var(--ff-text-secondary)]">Require PO match</span>
              <Info className="h-3.5 w-3.5 text-slate-500" />
              <span className="text-xs text-slate-500">Enabled in Phase 4</span>
            </label>
          </section>

          {/* Learning stats */}
          <section className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-3">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Learning</h2>
              {promoted && (
                <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal-500/20 text-teal-400">Promoted</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-[var(--ff-text-tertiary)] text-xs uppercase mb-1">Samples learned</p>
                <p className="text-[var(--ff-text-primary)] font-semibold">{rule?.learnedSampleCount ?? 0}</p>
              </div>
              <div>
                <p className="text-[var(--ff-text-tertiary)] text-xs uppercase mb-1">Last correction</p>
                <p className="text-[var(--ff-text-primary)] font-semibold">{fmtDate(rule?.learnedFromLastCorrectionAt ?? null)}</p>
              </div>
            </div>
            {!rule && (
              <p className="text-xs text-[var(--ff-text-tertiary)]">No rule configured yet — save below to create one.</p>
            )}
          </section>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            <button onClick={() => void handleSave()} disabled={saving || !isDirty}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {rule ? 'Save changes' : 'Create rule'}
            </button>

            {rule && !confirmDelete && (
              <button onClick={() => setConfirmDelete(true)}
                className="px-4 py-2.5 text-sm font-medium text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-400/50 rounded-lg transition-colors">
                Delete rule
              </button>
            )}
            {rule && confirmDelete && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--ff-text-secondary)]">Confirm delete?</span>
                <button onClick={() => void handleDelete()} disabled={deleting}
                  className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded text-sm font-medium">
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Yes, delete'}
                </button>
                <button onClick={() => setConfirmDelete(false)} className="px-3 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
