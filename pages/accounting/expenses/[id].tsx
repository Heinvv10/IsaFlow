/**
 * Expense Claim detail (PRD-05 Phase 10)
 *
 * Shows lines, supports adding lines (regular + mileage), submit / approve /
 * reject / post. Posting asks for reimbursement GL account (and optional VAT
 * input account).
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { ClaimHeaderBanners, ClaimToast } from '@/components/accounting/expense/ClaimHeaderBanners';
import {
  ChevronLeft, Loader2, AlertCircle, Send, Check, X, FileCheck,
  MapPin, Receipt, DollarSign,
} from 'lucide-react';

interface Line {
  id: string;
  lineDate: string;
  description: string | null;
  merchant: string | null;
  amount: number;
  vatAmount: number;
  vatCode: string | null;
  glAccountId: string | null;
  costCentreId: string | null;
  projectId: string | null;
  sourceDocumentId: string | null;
  kmTravelled: number | null;
  kmRate: number | null;
  mileageFrom: string | null;
  mileageTo: string | null;
}

interface Claim {
  id: string;
  claimNumber: string;
  claimDate: string;
  employeeId: string;
  title: string | null;
  description: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'posted' | 'paid' | 'cancelled';
  totalAmount: number;
  totalVat: number;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  postedJeId: string | null;
  postedAt: string | null;
  submittedAt: string | null;
  lines: Line[];
}

interface GlAccount { id: string; code: string; name: string }

function fmtZAR(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ExpenseClaimDetail() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  const [claim, setClaim] = useState<Claim | null>(null);
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  // The s17(2)(a) advice the approve/reject endpoint returns. It was computed
  // and thrown away here — `json.data.claim` was destructured and the rest
  // dropped — so the person the module doc calls "the last person who sees the
  // claim before postClaim debits VAT Input" was never actually warned.
  const [vatAdvice, setVatAdvice] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [addMode, setAddMode] = useState<'none' | 'receipt' | 'mileage'>('none');
  const [postMode, setPostMode] = useState(false);

  // Receipt line fields
  const [rcLineDate, setRcLineDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rcMerchant, setRcMerchant] = useState('');
  const [rcDescription, setRcDescription] = useState('');
  const [rcAmount, setRcAmount] = useState('');
  const [rcVat, setRcVat] = useState('');
  const [rcGlAccount, setRcGlAccount] = useState('');

  // Mileage fields
  const [mlKm, setMlKm] = useState('');
  const [mlFrom, setMlFrom] = useState('');
  const [mlTo, setMlTo] = useState('');
  const [mlDate, setMlDate] = useState(() => new Date().toISOString().slice(0, 10));

  // Post fields
  const [postReimbAcct, setPostReimbAcct] = useState('');
  const [postVatAcct, setPostVatAcct] = useState('');

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const loadClaim = useCallback(async () => {
    if (!id) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/accounting/expense-claims/${id}`);
      const json = await res.json() as { data?: { claim?: Claim }; error?: { message?: string } | string };
      if (!res.ok || !json.data?.claim) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Failed to load';
        setError(msg); return;
      }
      setClaim(json.data.claim);
    } catch { setError('Network error'); }
    finally { setLoading(false); }
  }, [id]);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts?limit=500');
      const json = await res.json() as { data?: { accounts?: GlAccount[] } };
      setAccounts(json.data?.accounts ?? []);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { void loadClaim(); void loadAccounts(); }, [loadClaim, loadAccounts]);

  async function handleAddReceipt() {
    if (!id || !rcLineDate || !rcAmount || !rcGlAccount) {
      showToast('Date, amount, GL account required', false); return;
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/accounting/expense-claims/${id}`, {
        method: 'POST',
        body: JSON.stringify({
          lineDate: rcLineDate, description: rcDescription || null,
          merchant: rcMerchant || null, amount: parseFloat(rcAmount),
          vatAmount: rcVat ? parseFloat(rcVat) : 0,
          vatCode: rcVat ? 'STD' : null, glAccountId: rcGlAccount,
          costCentreId: null, projectId: null, sourceDocumentId: null,
          kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
        }),
      });
      const json = await res.json() as { data?: { claim?: Claim }; error?: { message?: string } | string };
      if (!res.ok || !json.data?.claim) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Add failed';
        showToast(msg, false); return;
      }
      showToast('Line added', true);
      setClaim(json.data.claim);
      setRcMerchant(''); setRcDescription(''); setRcAmount(''); setRcVat(''); setRcGlAccount('');
      setAddMode('none');
    } catch { showToast('Network error', false); }
    finally { setBusy(false); }
  }

  async function handleAddMileage() {
    if (!id || !mlKm || parseFloat(mlKm) <= 0) { showToast('km required', false); return; }
    setBusy(true);
    try {
      const res = await apiFetch('/api/accounting/expense-claims/mileage-trip', {
        method: 'POST',
        body: JSON.stringify({
          claimId: id, km: parseFloat(mlKm), tripDate: mlDate,
          from: mlFrom || null, to: mlTo || null,
        }),
      });
      const json = await res.json() as { data?: { claim?: Claim }; error?: { message?: string } | string };
      if (!res.ok) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Add failed';
        showToast(msg, false); return;
      }
      showToast(`Added mileage (${mlKm} km)`, true);
      if (json.data?.claim) setClaim(json.data.claim);
      setMlKm(''); setMlFrom(''); setMlTo('');
      setAddMode('none');
    } catch { showToast('Network error', false); }
    finally { setBusy(false); }
  }

  async function handleTransition(endpoint: string, body: object = {}) {
    if (!id) return;
    setBusy(true);
    try {
      const res = await apiFetch(`/api/accounting/expense-claims/${id}/${endpoint}`, {
        method: 'POST', body: JSON.stringify(body),
      });
      const json = await res.json() as { data?: { claim?: Claim; warnings?: string[] }; error?: { message?: string } | string };
      if (!res.ok || !json.data?.claim) {
        const msg = typeof json.error === 'string' ? json.error : json.error?.message ?? 'Failed';
        showToast(msg, false); return;
      }
      setVatAdvice(json.data.warnings ?? []);
      setClaim(json.data.claim);
      showToast(`Claim ${json.data.claim.status}`, true);
      if (endpoint === 'post') setPostMode(false);
    } catch { showToast('Network error', false); }
    finally { setBusy(false); }
  }

  if (loading) {
    return <AppLayout><div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div></AppLayout>;
  }
  if (error || !claim) {
    return <AppLayout><div className="flex items-center gap-2 text-red-400 py-16 justify-center"><AlertCircle className="h-5 w-5" />{error || 'Not found'}</div></AppLayout>;
  }

  const canEdit = claim.status === 'draft';
  const canSubmit = claim.status === 'draft' && claim.lines.length > 0;
  const canApprove = claim.status === 'submitted';
  const canPost = claim.status === 'approved';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
          <Link href="/accounting/expenses" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 mb-1">
            <ChevronLeft className="h-3 w-3" /> Expense claims
          </Link>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">{claim.claimNumber}</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">{claim.title ?? 'Untitled claim'} · {claim.claimDate}</p>
            </div>
            <div className="flex items-center gap-2">
              {canSubmit && (
                <button onClick={() => void handleTransition('submit')} disabled={busy}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-60">
                  <Send className="h-4 w-4" /> Submit
                </button>
              )}
              {canApprove && (
                <>
                  <button onClick={() => void handleTransition('approve', { decision: 'approve' })} disabled={busy}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium disabled:opacity-60">
                    <Check className="h-4 w-4" /> Approve
                  </button>
                  <button onClick={() => {
                      const reason = prompt('Rejection reason?');
                      if (reason) void handleTransition('approve', { decision: 'reject', reason });
                    }} disabled={busy}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded bg-red-700 hover:bg-red-600 text-white text-sm font-medium disabled:opacity-60">
                    <X className="h-4 w-4" /> Reject
                  </button>
                </>
              )}
              {canPost && (
                <button onClick={() => setPostMode(true)} disabled={busy}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-60">
                  <FileCheck className="h-4 w-4" /> Post to GL
                </button>
              )}
            </div>
          </div>
        </div>

        <ClaimToast toast={toast} />

        <div className="px-6 py-6 space-y-4">
          <ClaimHeaderBanners
            vatAdvice={vatAdvice}
            rejectionReason={claim.rejectionReason}
            totalAmount={claim.totalAmount}
            totalVat={claim.totalVat}
            lineCount={claim.lines.length}
          />

          {/* Lines */}
          <div className="bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-[rgba(255,255,255,0.06)] flex items-center justify-between">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Lines</h2>
              {canEdit && addMode === 'none' && (
                <div className="flex gap-2">
                  <button onClick={() => setAddMode('receipt')}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-xs">
                    <Receipt className="h-3.5 w-3.5" /> Add receipt
                  </button>
                  <button onClick={() => setAddMode('mileage')}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-xs">
                    <MapPin className="h-3.5 w-3.5" /> Add mileage
                  </button>
                </div>
              )}
            </div>

            {addMode === 'receipt' && (
              <div className="px-6 py-4 bg-white/5 border-b border-[rgba(255,255,255,0.06)] grid grid-cols-6 gap-2 text-sm">
                <input type="date" value={rcLineDate} onChange={e => setRcLineDate(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
                <input placeholder="Merchant" value={rcMerchant} onChange={e => setRcMerchant(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
                <input placeholder="Description" value={rcDescription} onChange={e => setRcDescription(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
                <input type="number" step="0.01" placeholder="Amount" value={rcAmount} onChange={e => setRcAmount(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 text-right" />
                <input type="number" step="0.01" placeholder="VAT" value={rcVat} onChange={e => setRcVat(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 text-right" />
                <select value={rcGlAccount} onChange={e => setRcGlAccount(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 text-xs">
                  <option value="">GL account…</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </select>
                <div className="col-span-6 flex gap-2 justify-end">
                  <button onClick={() => setAddMode('none')} className="px-3 py-1.5 text-slate-400 hover:text-slate-200 text-xs">Cancel</button>
                  <button onClick={() => void handleAddReceipt()} disabled={busy}
                    className="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white text-xs font-medium disabled:opacity-60">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add line'}
                  </button>
                </div>
              </div>
            )}

            {addMode === 'mileage' && (
              <div className="px-6 py-4 bg-white/5 border-b border-[rgba(255,255,255,0.06)] grid grid-cols-6 gap-2 text-sm">
                <input type="date" value={mlDate} onChange={e => setMlDate(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
                <input placeholder="From" value={mlFrom} onChange={e => setMlFrom(e.target.value)}
                  className="col-span-2 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
                <input placeholder="To" value={mlTo} onChange={e => setMlTo(e.target.value)}
                  className="col-span-2 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200" />
                <input type="number" step="0.1" placeholder="km" value={mlKm} onChange={e => setMlKm(e.target.value)}
                  className="col-span-1 px-2 py-1.5 rounded bg-white/5 border border-[rgba(255,255,255,0.08)] text-slate-200 text-right" />
                <div className="col-span-6 flex gap-2 justify-end items-center">
                  <p className="text-xs text-slate-500 flex-1">Uses SARS prescribed rate (from company settings).</p>
                  <button onClick={() => setAddMode('none')} className="px-3 py-1.5 text-slate-400 hover:text-slate-200 text-xs">Cancel</button>
                  <button onClick={() => void handleAddMileage()} disabled={busy}
                    className="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white text-xs font-medium disabled:opacity-60">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Add mileage'}
                  </button>
                </div>
              </div>
            )}

            {claim.lines.length === 0 ? (
              <div className="py-12 text-center">
                <DollarSign className="h-8 w-8 mx-auto text-slate-600 mb-2" />
                <p className="text-sm text-slate-500">No lines yet</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase tracking-wider border-b border-[rgba(255,255,255,0.06)]">
                    <th className="px-6 py-3 font-medium">Date</th>
                    <th className="px-6 py-3 font-medium">Type</th>
                    <th className="px-6 py-3 font-medium">Description</th>
                    <th className="px-6 py-3 text-right font-medium">km</th>
                    <th className="px-6 py-3 text-right font-medium">VAT</th>
                    <th className="px-6 py-3 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                  {claim.lines.map(l => (
                    <tr key={l.id} className="hover:bg-white/5">
                      <td className="px-6 py-3 text-slate-400">{l.lineDate}</td>
                      <td className="px-6 py-3">
                        {l.kmTravelled ? (
                          <span className="inline-flex items-center gap-1 text-xs text-teal-400"><MapPin className="h-3 w-3" /> Mileage</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Receipt className="h-3 w-3" /> Receipt</span>
                        )}
                      </td>
                      <td className="px-6 py-3 text-slate-300">
                        {l.description ?? '—'}
                        {l.merchant && <span className="text-xs text-slate-500 block">{l.merchant}</span>}
                        {l.mileageFrom && l.mileageTo && <span className="text-xs text-slate-500 block">{l.mileageFrom} → {l.mileageTo}</span>}
                      </td>
                      <td className="px-6 py-3 text-right text-slate-400 text-xs">{l.kmTravelled ? `${l.kmTravelled} @ R${l.kmRate}` : '—'}</td>
                      <td className="px-6 py-3 text-right text-slate-400 text-xs">{fmtZAR(l.vatAmount)}</td>
                      <td className="px-6 py-3 text-right text-slate-200 font-medium">{fmtZAR(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Post modal */}
        {postMode && (
          <div className="fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4" onClick={() => !busy && setPostMode(false)}>
            <div className="w-full max-w-md bg-[var(--ff-canvas-mid)] border border-[rgba(255,255,255,0.08)] rounded-xl p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Post to GL</h3>
              <div className="space-y-3 text-sm">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Reimbursement account (CR)</label>
                  <select value={postReimbAcct} onChange={e => setPostReimbAcct(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-xs">
                    <option value="">Select account…</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">VAT input account (DR, optional)</label>
                  <select value={postVatAcct} onChange={e => setPostVatAcct(e.target.value)}
                    className="w-full px-3 py-2 rounded bg-white/5 border border-[rgba(255,255,255,0.1)] text-slate-200 text-xs">
                    <option value="">None — skip VAT leg</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="mt-5 flex gap-2 justify-end">
                <button onClick={() => setPostMode(false)} disabled={busy}
                  className="px-4 py-2 rounded text-sm text-slate-300 hover:bg-white/5">Cancel</button>
                <button onClick={() => void handleTransition('post', {
                    reimbursementAccountId: postReimbAcct,
                    vatInputAccountId: postVatAcct || null,
                  })} disabled={busy || !postReimbAcct}
                  className="px-4 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium disabled:opacity-60">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Post'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
