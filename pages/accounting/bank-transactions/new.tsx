/**
 * Spend Money / Receive Money — manual bank transaction entry
 * Equivalent to Sage "Create Transaction" in Process Bank.
 */

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { notify } from '@/utils/toast';
import { apiFetch } from '@/lib/apiFetch';

type TxType = 'spend' | 'receive';
type AllocType = 'account' | 'supplier' | 'customer';
type VatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

interface SelectOption { id: string; name: string; code?: string; }
interface BankAcct { id: string; accountCode: string; accountName: string; bankAccountNumber?: string | null; }
interface FormState {
  bankAccountId: string; date: string; reference: string; description: string;
  amount: string; allocationType: AllocType; contraAccountId: string; entityId: string; vatCode: VatCode;
}

const todayISO = () => new Date().toISOString().split('T')[0]!;
const VAT_OPTIONS: { value: VatCode; label: string }[] = [
  { value: 'none', label: 'No VAT' }, { value: 'standard', label: 'Standard 15%' },
  { value: 'zero_rated', label: 'Zero Rated' }, { value: 'exempt', label: 'Exempt' },
];

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-teal-500 transition-colors';
const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: any[] = Array.isArray(json.data ?? json) ? (json.data ?? json) : [];
        setGlAccounts(list
          .filter(a => a.accountSubtype !== 'bank')
          .map(a => ({ id: a.id, code: a.accountCode ?? a.code, name: a.accountName ?? a.name })));
      }),
      apiFetch('/api/accounting/suppliers-list?status=active').then(r => r.json()).then(json => {
        if (!mounted) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: any[] = Array.isArray(json.data) ? json.data : [];
        setSuppliers(list.map(s => ({ id: String(s.id), name: s.name, code: s.code })));
      }),
      apiFetch('/api/accounting/customers').then(r => r.json()).then(json => {
        if (!mounted) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: any[] = Array.isArray(json.data) ? json.data : [];
        setCustomers(list.map(c => ({ id: c.id, name: c.company_name ?? c.companyName ?? c.name ?? '' })));
      }),
    ];
    Promise.allSettled(promises).finally(() => { if (mounted) setIsLoadingRef(false); });
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

  const handleSubmit = async (e: React.FormEvent) => {
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

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/accounting/bank-transactions"
              className="flex items-center gap-1.5 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
              <ArrowLeft className="h-4 w-4" /> Back
            </Link>
            <span className="text-[var(--ff-border-light)]">/</span>
            <h1 className="text-xl font-bold text-[var(--ff-text-primary)]">
              {txType === 'spend' ? 'Spend Money' : 'Receive Money'}
            </h1>
          </div>
        </div>

        {/* Spend / Receive tabs */}
        <div className="px-6 border-b border-[var(--ff-border-light)]">
          <div className="flex gap-0">
            {(['spend', 'receive'] as TxType[]).map(t => (
              <button key={t} type="button" onClick={() => setTxType(t)}
                className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${txType === t
                  ? 'border-teal-500 text-teal-400'
                  : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
                {t === 'spend' ? 'Spend Money' : 'Receive Money'}
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <div className="px-6 py-6 max-w-2xl">
          {isLoadingRef ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] p-6 space-y-5">

                {/* Bank Account */}
                <div>
                  <label className={LABEL_CLS}>Bank Account *</label>
                  <select value={form.bankAccountId} onChange={e => patch({ bankAccountId: e.target.value })}
                    className={INPUT_CLS} required>
                    <option value="">Select bank account…</option>
                    {bankAccounts.map(b => (
                      <option key={b.id} value={b.id}>
                        {b.accountCode} — {b.accountName}
                        {b.bankAccountNumber ? ` (****${b.bankAccountNumber.slice(-4)})` : ''}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Date / Reference */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={LABEL_CLS}>Date *</label>
                    <input type="date" value={form.date} onChange={e => patch({ date: e.target.value })}
                      className={INPUT_CLS} required />
                  </div>
                  <div>
                    <label className={LABEL_CLS}>Reference</label>
                    <input type="text" value={form.reference} onChange={e => patch({ reference: e.target.value })}
                      placeholder="e.g. INV-001" className={INPUT_CLS} />
                  </div>
                </div>

                {/* Description */}
                <div>
                  <label className={LABEL_CLS}>Description</label>
                  <input type="text" value={form.description} onChange={e => patch({ description: e.target.value })}
                    placeholder="Transaction description…" className={INPUT_CLS} />
                </div>

                {/* Amount */}
                <div>
                  <label className={LABEL_CLS}>Amount (ZAR) *</label>
                  <input type="number" min="0.01" step="0.01" value={form.amount}
                    onChange={e => patch({ amount: e.target.value })} placeholder="0.00"
                    className={INPUT_CLS} required />
                </div>

                <div className="border-t border-[var(--ff-border-light)]" />

                {/* Allocation Type toggle */}
                <div>
                  <label className={LABEL_CLS}>Allocate To</label>
                  <div className="flex gap-2">
                    {(['account', 'supplier', 'customer'] as AllocType[]).map(t => (
                      <button key={t} type="button" onClick={() => handleAllocTypeChange(t)}
                        className={`px-4 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                          form.allocationType === t
                            ? 'border-teal-500 bg-teal-500/10 text-teal-400'
                            : 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                        }`}>
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Searchable entity picker */}
                <div className="relative">
                  <label className={LABEL_CLS}>{entityLabel}</label>
                  <input type="text" value={entitySearch}
                    onChange={e => {
                      setEntitySearch(e.target.value);
                      if (form.allocationType === 'account') patch({ contraAccountId: '' });
                      else patch({ entityId: '' });
                    }}
                    placeholder={`Search ${form.allocationType}s…`}
                    className={INPUT_CLS} autoComplete="off" />
                  {entitySearch.length > 0 && !isSelected && (
                    <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl max-h-52 overflow-y-auto">
                      {entityOptions.length === 0
                        ? <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)]">No results found</div>
                        : entityOptions.map(o => {
                            const lbl = o.code ? `${o.code} — ${o.name}` : o.name;
                            return (
                              <button key={o.id} type="button" onClick={() => handleEntitySelect(o.id, lbl)}
                                className="w-full text-left px-3 py-2 hover:bg-[var(--ff-bg-primary)] text-sm flex items-center gap-2">
                                {o.code && <span className="font-mono text-xs text-[var(--ff-text-tertiary)]">{o.code}</span>}
                                <span className="text-[var(--ff-text-primary)]">{o.name}</span>
                              </button>
                            );
                          })
                      }
                    </div>
                  )}
                </div>

                {/* VAT Code */}
                <div>
                  <label className={LABEL_CLS}>VAT Code</label>
                  <select value={form.vatCode} onChange={e => patch({ vatCode: e.target.value as VatCode })}
                    className={INPUT_CLS}>
                    {VAT_OPTIONS.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                  </select>
                </div>
              </div>

              {/* Actions */}
              <div className="mt-6 flex items-center gap-3">
                <button type="submit" disabled={isSubmitting}
                  className="flex items-center gap-2 px-6 py-2.5 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                  {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Record Transaction
                </button>
                <Link href="/accounting/bank-transactions"
                  className="px-5 py-2.5 rounded-lg border border-[var(--ff-border-light)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors">
                  Cancel
                </Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
