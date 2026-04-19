/**
 * Create Loan Form
 * Route: /accounting/loans/new
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Landmark, ArrowLeft, Loader2 } from 'lucide-react';
import { RateCurve } from '@/components/loans/types';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

interface LoanForm {
  reference: string;
  product: string;
  description: string;
  principal: string;
  startDate: string;
  termMonths: string;
  rateMode: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS';
  fixedRate: string;
  margin: string;
  residual: string;
  curveId: string;
  recurringSkipMonths: number[];
  repriceMode: string;
  skipMode: string;
  lumpMode: string;
  originationFee: string;
  originationFeeVatType: 'standard' | 'zero' | 'exempt';
}

const INITIAL: LoanForm = {
  reference: '', product: 'bond', description: '',
  principal: '', startDate: '', termMonths: '',
  rateMode: 'FIXED', fixedRate: '', margin: '', residual: '0', curveId: '',
  recurringSkipMonths: [],
  repriceMode: 'RESOLVE_ON_RATE_CHANGE',
  skipMode: 'MAINTAIN_TERM',
  lumpMode: 'REDUCE_INSTALLMENT',
  originationFee: '0',
  originationFeeVatType: 'standard',
};

export default function NewLoanPage() {
  const router = useRouter();
  const [form, setForm] = useState<LoanForm>(INITIAL);
  const [curves, setCurves] = useState<RateCurve[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/api/accounting/loan-rate-curves')
      .then(r => r.json())
      .then(j => setCurves(j.data ?? []))
      .catch(() => setCurves([]));
  }, []);

  const set = <K extends keyof LoanForm>(k: K, v: LoanForm[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const toggleSkipMonth = (m: number) => {
    setForm(f => ({
      ...f,
      recurringSkipMonths: f.recurringSkipMonths.includes(m)
        ? f.recurringSkipMonths.filter(x => x !== m)
        : [...f.recurringSkipMonths, m],
    }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        reference: form.reference || null,
        product: form.product,
        description: form.description || null,
        principal: Number(form.principal),
        startDate: form.startDate,
        termMonths: Number(form.termMonths),
        rateMode: form.rateMode,
        fixedRate: form.rateMode === 'FIXED' ? Number(form.fixedRate) : null,
        margin: form.rateMode !== 'FIXED' ? Number(form.margin) : 0,
        residual: Number(form.residual),
        curveId: form.rateMode !== 'FIXED' && form.curveId ? form.curveId : null,
        recurringSkipMonths: form.recurringSkipMonths,
        repriceMode: form.repriceMode,
        skipMode: form.skipMode,
        lumpMode: form.lumpMode,
        originationFee: Number(form.originationFee || '0'),
        originationFeeVatType: form.originationFeeVatType,
      };
      const res = await apiFetch('/api/accounting/loans', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to create loan');
      await router.push(`/accounting/loans/${json.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create loan');
    } finally {
      setBusy(false);
    }
  };

  const isPrime = form.rateMode !== 'FIXED';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/accounting/loans" className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Landmark className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Loan</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Create a new amortisation schedule</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <section className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide">Basic Details</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Reference</label>
                  <input className="ff-input w-full text-sm" placeholder="e.g. LOAN-2024-001" value={form.reference} onChange={e => set('reference', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Product *</label>
                  <select className="ff-select w-full text-sm" value={form.product} onChange={e => set('product', e.target.value)} required>
                    <option value="bond">Bond</option>
                    <option value="vehicle_finance">Vehicle Finance</option>
                    <option value="shareholder_loan">Shareholder Loan</option>
                    <option value="inter_company">Inter-Company</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Description</label>
                  <input className="ff-input w-full text-sm" placeholder="Optional description" value={form.description} onChange={e => set('description', e.target.value)} />
                </div>
              </div>
            </section>

            <section className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide">Financial Terms</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Principal (ZAR) *</label>
                  <input type="number" step="0.01" min="1" className="ff-input w-full text-sm" placeholder="1000000.00" value={form.principal} onChange={e => set('principal', e.target.value)} required />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Residual (ZAR)</label>
                  <input type="number" step="0.01" min="0" className="ff-input w-full text-sm" placeholder="0.00" value={form.residual} onChange={e => set('residual', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Origination Fee (ZAR, excl VAT)</label>
                  <input type="number" step="0.01" min="0" className="ff-input w-full text-sm" placeholder="0.00" value={form.originationFee} onChange={e => set('originationFee', e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Origination Fee VAT</label>
                  <select className="ff-select w-full text-sm" value={form.originationFeeVatType} onChange={e => set('originationFeeVatType', e.target.value as 'standard' | 'zero' | 'exempt')}>
                    <option value="standard">Standard (15%)</option>
                    <option value="zero">Zero-rated</option>
                    <option value="exempt">Exempt</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Start Date *</label>
                  <input type="date" className="ff-input w-full text-sm" value={form.startDate} onChange={e => set('startDate', e.target.value)} required />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Term (months) *</label>
                  <input type="number" min="1" max="600" className="ff-input w-full text-sm" placeholder="60" value={form.termMonths} onChange={e => set('termMonths', e.target.value)} required />
                </div>
              </div>
            </section>

            <section className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide">Rate Configuration</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Rate Mode *</label>
                  <select className="ff-select w-full text-sm" value={form.rateMode} onChange={e => set('rateMode', e.target.value as LoanForm['rateMode'])} required>
                    <option value="FIXED">Fixed</option>
                    <option value="PRIME_PLUS">Prime Plus</option>
                    <option value="PRIME_MINUS">Prime Minus</option>
                  </select>
                </div>
                {!isPrime && (
                  <div>
                    <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Fixed Rate (%) *</label>
                    <input type="number" step="0.0001" min="0" className="ff-input w-full text-sm" placeholder="10.5" value={form.fixedRate} onChange={e => set('fixedRate', e.target.value)} required />
                  </div>
                )}
                {isPrime && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Margin (%) *</label>
                      <input type="number" step="0.0001" min="0" className="ff-input w-full text-sm" placeholder="2.0" value={form.margin} onChange={e => set('margin', e.target.value)} required />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Rate Curve</label>
                      <select className="ff-select w-full text-sm" value={form.curveId} onChange={e => set('curveId', e.target.value)}>
                        <option value="">No curve (manual prime rate)</option>
                        {curves.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </>
                )}
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Reprice Mode *</label>
                  <select className="ff-select w-full text-sm" value={form.repriceMode} onChange={e => set('repriceMode', e.target.value)} required>
                    <option value="RESOLVE_ON_RATE_CHANGE">Resolve on Rate Change</option>
                    <option value="RESOLVE_EVERY_PERIOD">Resolve Every Period</option>
                    <option value="FIXED_INSTALLMENT">Fixed Installment</option>
                  </select>
                </div>
              </div>
            </section>

            <section className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wide">Payment Behaviour</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Skip Mode *</label>
                  <select className="ff-select w-full text-sm" value={form.skipMode} onChange={e => set('skipMode', e.target.value)} required>
                    <option value="MAINTAIN_TERM">Maintain Term</option>
                    <option value="EXTEND_TERM">Extend Term</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-1">Lump Sum Mode *</label>
                  <select className="ff-select w-full text-sm" value={form.lumpMode} onChange={e => set('lumpMode', e.target.value)} required>
                    <option value="REDUCE_INSTALLMENT">Reduce Installment</option>
                    <option value="MAINTAIN_INSTALLMENT">Maintain Installment</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] mb-2">Recurring Skip Months</label>
                <div className="flex flex-wrap gap-2">
                  {MONTHS.map((m, i) => {
                    const num = i + 1;
                    const active = form.recurringSkipMonths.includes(num);
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => toggleSkipMonth(num)}
                        className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                          active
                            ? 'bg-amber-500/20 border-amber-500/50 text-amber-400'
                            : 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                        }`}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <div className="flex items-center justify-end gap-3 pb-6">
              <Link href="/accounting/loans" className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                Cancel
              </Link>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Loan'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
