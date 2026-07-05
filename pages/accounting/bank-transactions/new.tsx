/**
 * Spend Money / Receive Money — manual bank transaction entry
 * Equivalent to Sage "Create Transaction" in Process Bank.
 */

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeft, Loader2, Receipt, Banknote } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';

type TxType = 'spend' | 'receive';
type AllocType = 'account' | 'supplier' | 'customer';
type VatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

interface SelectOption { id: string; name: string; code?: string }
interface BankAcct { id: string; accountCode: string; accountName: string; bankAccountNumber?: string | null }
interface GlAccountOption {
  id: string;
  accountCode?: string | null;
  code?: string | null;
  accountName?: string | null;
  name?: string | null;
  accountSubtype?: string | null;
}
interface EntityOption {
  id: string;
  name?: string | null;
  code?: string | null;
  company_name?: string | null;
  companyName?: string | null;
}
interface FormState {
  bankAccountId: string; date: string; reference: string; description: string;
  amount: string; allocationType: AllocType; contraAccountId: string; entityId: string; vatCode: VatCode;
}

const todayISO = () => new Date().toISOString().split('T')[0]!;
const VAT_OPTIONS: { value: VatCode; label: string }[] = [
  { value: 'none', label: 'No VAT' }, { value: 'standard', label: 'Standard 15%' },
  { value: 'zero_rated', label: 'Zero Rated' }, { value: 'exempt', label: 'Exempt' },
];
const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

const asArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

export default function NewBankTransactionPage() {
  const router = useRouter();
  const [txType, setTxType] = useState<TxType>('spend');
  const [form, setForm] = useState<FormState>({
    bankAccountId: '', date: todayISO(), reference: '', description: '',
    amount: '', allocationType: 'account', contraAccountId: '', entityId: '', vatCode: 'none',
  });
  const [entitySearch, setEntitySearch] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<BankAcct[]>([]);
  const [glAccounts, setGlAccounts] = useState<SelectOption[]>([]);
  const [suppliers, setSuppliers] = useState<SelectOption[]>([]);
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [isLoadingRef, setIsLoadingRef] = useState(true);

  useEffect(() => {
    let mounted = true;
    const promises = [
      apiFetch('/api/accounting/bank-accounts').then(r => r.json()).then(json => {
        if (!mounted) return;
        const list: BankAcct[] = Array.isArray(json.data ?? json) ? (json.data ?? json) : [];
        setBankAccounts(list);
        if (list.length > 0) setForm(prev => ({ ...prev, bankAccountId: list[0]!.id }));
      }),
      apiFetch('/api/accounting/chart-of-accounts').then(r => r.json()).then(json => {
        if (!mounted) return;
        const list = asArray<GlAccountOption>(json.data ?? json);
        setGlAccounts(list
          .filter(a => a.accountSubtype !== 'bank')
          .map(a => ({ id: a.id, code: a.accountCode ?? a.code ?? undefined, name: a.accountName ?? a.name ?? '' })));
      }),
      apiFetch('/api/accounting/suppliers-list?status=active').then(r => r.json()).then(json => {
        if (!mounted) return;
         
        const d = json.data ?? json;
        const list = Array.isArray(d) ? d as EntityOption[] : asArray<EntityOption>((d as { suppliers?: unknown }).suppliers);
        setSuppliers(list.map(s => ({ id: String(s.id), name: s.name ?? '', code: s.code ?? undefined })));
      }),
      apiFetch('/api/accounting/customers').then(r => r.json()).then(json => {
        if (!mounted) return;
        const list = asArray<EntityOption>(json.data);
        setCustomers(list.map(c => ({ id: String(c.id), name: c.company_name ?? c.companyName ?? c.name ?? '' })));
      }),
    ];
    void Promise.allSettled(promises).finally(() => { if (mounted) setIsLoadingRef(false); });
    return () => { mounted = false; };
  }, []);

  const entityOptions = useMemo((): SelectOption[] => {
    const base = form.allocationType === 'supplier' ? suppliers
      : form.allocationType === 'customer' ? customers : glAccounts;
    if (!entitySearch) return base;
    const q = entitySearch.toLowerCase();
    return base.filter(o => o.name.toLowerCase().includes(q) || (o.code ?? '').toLowerCase().includes(q));
  }, [form.allocationType, entitySearch, glAccounts, suppliers, customers]);

  const patch = (updates: Partial<FormState>) => setForm(prev => ({ ...prev, ...updates }));

  const handleAllocTypeChange = (allocationType: AllocType) => {
    patch({ allocationType, contraAccountId: '', entityId: '' });
    setEntitySearch('');
  };

  const handleEntitySelect = (id: string, label: string) => {
    if (form.allocationType === 'account') patch({ contraAccountId: id });
    else patch({ entityId: id });
    setEntitySearch(label);
  };

  const validate = (): string | null => {
    if (!form.bankAccountId) return 'Select a bank account';
    if (!form.date) return 'Date is required';
    const amt = Number(form.amount);
    if (!form.amount || isNaN(amt) || amt <= 0) return 'Enter a valid positive amount';
    if (form.allocationType === 'account' && !form.contraAccountId) return 'Select a GL account';
    if ((form.allocationType === 'supplier' || form.allocationType === 'customer') && !form.entityId)
      return `Select a ${form.allocationType}`;
    return null;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const err = validate();
    if (err) { notify.error(err); return; }
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/bank-transactions-manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          type: txType, bankAccountId: form.bankAccountId, date: form.date, amount: Number(form.amount),
          reference: form.reference || undefined, description: form.description || undefined,
          allocationType: form.allocationType, contraAccountId: form.contraAccountId || undefined,
          entityId: form.entityId || undefined, vatCode: form.vatCode,
        }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false)
        throw new Error(json.error?.message ?? json.message ?? 'Failed to record transaction');
      notify.success('Transaction recorded successfully');
      void router.push('/accounting/bank-transactions');
    } catch (error) {
      notify.error(error instanceof Error ? error.message : 'Failed to record transaction');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isSelected = form.allocationType === 'account' ? !!form.contraAccountId : !!form.entityId;
  const entityLabel = form.allocationType === 'account' ? 'GL Account *'
    : form.allocationType === 'supplier' ? 'Supplier *' : 'Customer *';
  const amountNum = Number(form.amount) || 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/bank-transactions" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Bank Transactions
            </Link>
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white">{txType === 'spend' ? 'Spend Money' : 'Receive Money'}</h1>
            </div>
          </div>
        </div>

        {/* Type toggle */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-fit">
            {(['spend', 'receive'] as TxType[]).map(t => (
              <button key={t} type="button" onClick={() => setTxType(t)}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${txType === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}>
                {t === 'spend' ? 'Spend Money' : 'Receive Money'}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column */}
            <div className="flex-1 min-w-0">
              {isLoadingRef ? (
                <div className="flex items-center justify-center py-24">
                  <Loader2 className="h-8 w-8 animate-spin text-amber-500" />
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate className="space-y-5">
                  {/* Bank & Transaction */}
                  <div className={`${card} p-5`}>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                      <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                      Transaction Details
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <label className={lbl}>Bank Account *</label>
                        <select name="bankAccountId" value={form.bankAccountId} onChange={e => patch({ bankAccountId: e.target.value })} className={inp} required>
                          <option value="">Select bank account…</option>
                          {bankAccounts.map(b => (
                            <option key={b.id} value={b.id}>
                              {b.accountCode} — {b.accountName}{b.bankAccountNumber ? ` (****${b.bankAccountNumber.slice(-4)})` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className={lbl}>Date *</label>
                          <input type="date" name="date" value={form.date} onChange={e => patch({ date: e.target.value })} className={inp} required />
                        </div>
                        <div>
                          <label className={lbl}>Reference</label>
                          <input type="text" name="reference" value={form.reference} onChange={e => patch({ reference: e.target.value })} placeholder="e.g. INV-001" className={inp} />
                        </div>
                      </div>
                      <div>
                        <label className={lbl}>Description</label>
                        <input type="text" name="description" value={form.description} onChange={e => patch({ description: e.target.value })} placeholder="Transaction description…" className={inp} />
                      </div>
                      <div>
                        <label className={lbl}>Amount (ZAR) *</label>
                        <input type="number" name="amount" min="0.01" step="0.01" value={form.amount} onChange={e => patch({ amount: e.target.value })} placeholder="0.00" className={inp} required />
                      </div>
                    </div>
                  </div>

                  {/* Allocation */}
                  <div className={`${card} p-5`}>
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                      <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                      Allocation
                    </h3>
                    <div className="space-y-4">
                      <div>
                        <label className={lbl}>Allocate To</label>
                        <div className="flex gap-2">
                          {(['account', 'supplier', 'customer'] as AllocType[]).map(t => (
                            <button key={t} type="button" onClick={() => handleAllocTypeChange(t)}
                              className={`px-4 py-1.5 rounded-lg border text-xs font-medium transition-all ${ form.allocationType === t ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-amber-400/50 hover:text-amber-500' }`}>
                              {t.charAt(0).toUpperCase() + t.slice(1)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="relative">
                        <label className={lbl}>{entityLabel}</label>
                        <input type="text" name="search" value={entitySearch}
                          onChange={e => {
                            setEntitySearch(e.target.value);
                            if (form.allocationType === 'account') patch({ contraAccountId: '' });
                            else patch({ entityId: '' });
                          }}
                          placeholder={`Search ${form.allocationType}s…`}
                          className={inp} autoComplete="off" />
                        {entitySearch.length > 0 && !isSelected && (
                          <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-52 overflow-y-auto">
                            {entityOptions.length === 0
                              ? <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">No results found</div>
                              : entityOptions.map(o => {
                                  const label = o.code ? `${o.code} — ${o.name}` : o.name;
                                  return (
                                    <button key={o.id} type="button" onClick={() => handleEntitySelect(o.id, label)}
                                      className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm flex items-center gap-2 transition-colors">
                                      {o.code && <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{o.code}</span>}
                                      <span className="text-slate-900 dark:text-slate-100">{o.name}</span>
                                    </button>
                                  );
                                })
                            }
                          </div>
                        )}
                      </div>
                      <div>
                        <label className={lbl}>VAT Code</label>
                        <select name="vatCode" value={form.vatCode} onChange={e => patch({ vatCode: e.target.value as VatCode })} className={inp}>
                          {VAT_OPTIONS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                </form>
              )}
            </div>

            {/* Right column — summary */}
            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Type</span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${txType === 'spend' ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400' : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'}`}>
                        {txType === 'spend' ? 'Spend' : 'Receive'}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Amount</span>
                      <span className="font-mono font-bold text-amber-500">
                        {amountNum > 0 ? `R ${amountNum.toFixed(2)}` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">VAT</span>
                      <span className="text-slate-700 dark:text-slate-300 text-xs">{VAT_OPTIONS.find(v => v.value === form.vatCode)?.label}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => handleSubmit(e as unknown as React.FormEvent<HTMLFormElement>)}
                    disabled={isSubmitting || isLoadingRef}
                    className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
                  >
                    {isSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />Recording…</> : <><Banknote className="h-4 w-4" />Record Transaction</>}
                  </button>
                  <Link href="/accounting/bank-transactions" className="block mt-3 text-center text-xs text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                    Cancel
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
