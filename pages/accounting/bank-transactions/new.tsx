/**
 * Spend Money / Receive Money — manual bank transaction entry
 * Equivalent to Sage "Create Transaction" in Process Bank.
 */

import { useState, useMemo, useRef } from 'react';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Loader2, Receipt, Banknote } from 'lucide-react';
import { notify } from '@/utils/toast';
import { log } from '@/lib/logger';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { truncatedSuppliersNotice } from '@/lib/fetchAllSuppliers';
import { notifyLateClaims } from '@/components/accounting/lateClaimNotice';
import { formatMoney } from '@/lib/money/formatMoney';
import { PageHeader, DateField } from '@/components/ui';
import {
  VAT_OPTIONS, card, inp, lbl, todayISO, type AllocType, type FormState, type SelectOption, type TxType, type VatCode,
} from '@/components/accounting/bank-transaction-new/newBankTxForm';
import { useNewBankTxReferenceData } from '@/components/accounting/bank-transaction-new/useNewBankTxReferenceData';

export default function NewBankTransactionPage() {
  const router = useRouter();
  const [txType, setTxType] = useState<TxType>('spend');
  const [form, setForm] = useState<FormState>({
    bankAccountId: '', date: todayISO(), reference: '', description: '',
    amount: '', allocationType: 'account', contraAccountId: '', entityId: '', vatCode: 'none',
  });
  const [entitySearch, setEntitySearch] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { bankAccounts, glAccounts, suppliers, suppliersFailed, suppliersTruncated, customers, isLoadingRef } =
    useNewBankTxReferenceData(setForm);

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

  const idempotency = useIdempotencyKey();
  const inFlight = useRef(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current) return; // state alone lets a second click in before the re-render that disables the button
    const err = validate();
    if (err) { notify.error(err); return; }
    inFlight.current = true;
    setIsSubmitting(true);
    try {
      const body = JSON.stringify({
        type: txType, bankAccountId: form.bankAccountId, date: form.date, amount: Number(form.amount),
        reference: form.reference || undefined, description: form.description || undefined,
        allocationType: form.allocationType, contraAccountId: form.contraAccountId || undefined,
        entityId: form.entityId || undefined, vatCode: form.vatCode,
      });
      const res = await apiFetch('/api/accounting/bank-transactions-manual', {
        method: 'POST', credentials: 'include', body,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency.keyFor(body) },
      });
      await assertOk(res, 'Could not record the transaction - try again');
      const json = await res.json();
      idempotency.done(); // only once the answer has parsed: a body that did not arrive keeps the key for the retry
      if (json.success === false) { notify.error(json.error?.message ?? json.message ?? 'Could not record the transaction - try again'); return; }
      notify.success('Transaction recorded successfully');
      notifyLateClaims(json); // VAT claimed in a later period (s16(3))
      try { await router.push('/accounting/bank-transactions'); } catch (e) { log.warn('navigation failed', { error: e }, 'bank-transactions-new'); }
    } catch (error) {
      notify.error(apiErrorMessage(error, 'Could not record the transaction - try again'));
    } finally {
      inFlight.current = false;
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
        <PageHeader
          icon={Banknote}
          title={txType === 'spend' ? 'Spend Money' : 'Receive Money'}
          breadcrumb={[{ label: 'Bank Transactions', href: '/accounting/bank-transactions' }, { label: 'New transaction' }]}
          className="mb-0"
        />

        {/* Type toggle */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-fit">
            {(['spend', 'receive'] as TxType[]).map(t => (
              <button key={t} type="button" onClick={() => setTxType(t)}
                className={`px-4 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${txType === t ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}`}>
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
                        <label htmlFor="bank-transactions-new-bank-account-id" className={lbl}>Bank account *</label>
                        <select id="bank-transactions-new-bank-account-id" name="bankAccountId" value={form.bankAccountId} onChange={e => patch({ bankAccountId: e.target.value })} className={inp} required>
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
                          <DateField label="Date" required name="date" value={form.date || null}
                            onChange={(iso, v) => patch({ date: v.valid ? iso ?? '' : '' })} />
                        </div>
                        <div>
                          <label htmlFor="bank-transactions-new-reference" className={lbl}>Reference</label>
                          <input id="bank-transactions-new-reference" type="text" name="reference" value={form.reference} onChange={e => patch({ reference: e.target.value })} placeholder="e.g. INV-001" className={inp} />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="bank-transactions-new-description" className={lbl}>Description</label>
                        <input id="bank-transactions-new-description" type="text" name="description" value={form.description} onChange={e => patch({ description: e.target.value })} placeholder="Transaction description…" className={inp} />
                      </div>
                      <div>
                        <label htmlFor="bank-transactions-new-amount" className={lbl}>Amount (ZAR) *</label>
                        <input id="bank-transactions-new-amount" type="number" name="amount" min="0.01" step="0.01" value={form.amount} onChange={e => patch({ amount: e.target.value })} placeholder="0.00" className={inp} required />
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
                        <label className={lbl}>Allocate to</label>
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
                        <label htmlFor="bank-transactions-new-search" className={lbl}>{entityLabel}</label>
                        <input id="bank-transactions-new-search" type="text" name="search" value={entitySearch}
                          onChange={e => {
                            setEntitySearch(e.target.value);
                            if (form.allocationType === 'account') patch({ contraAccountId: '' });
                            else patch({ entityId: '' });
                          }}
                          placeholder={`Search ${form.allocationType}s…`}
                          className={inp} autoComplete="off" />
                        {form.allocationType === 'supplier' && suppliersFailed && (
                          <p role="alert" className="mt-1 text-xs text-red-500">Suppliers failed to load — reload the page to allocate to a supplier.</p>
                        )}
                        {form.allocationType === 'supplier' && suppliersTruncated && (
                          <p role="status" className="mt-1 text-xs text-amber-500">{truncatedSuppliersNotice()}</p>
                        )}
                        {entitySearch.length > 0 && !isSelected && (
                          <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl max-h-52 overflow-y-auto">
                            {entityOptions.length === 0
                              ? <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">No results found</div>
                              : entityOptions.map(o => {
                                  const label = o.code ? `${o.code} — ${o.name}` : o.name;
                                  return (
                                    <button key={o.id} type="button" onClick={() => handleEntitySelect(o.id, label)}
                                      className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm flex items-center gap-2 transition-colors">
                                      {o.code && <span className="font-id text-xs text-slate-500 dark:text-slate-400">{o.code}</span>}
                                      <span className="text-slate-900 dark:text-slate-100">{o.name}</span>
                                    </button>
                                  );
                                })
                            }
                          </div>
                        )}
                      </div>
                      <div>
                        <label htmlFor="bank-transactions-new-vat-code" className={lbl}>VAT code</label>
                        <select id="bank-transactions-new-vat-code" name="vatCode" value={form.vatCode} onChange={e => patch({ vatCode: e.target.value as VatCode })} className={inp}>
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
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${txType === 'spend' ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'}`}>
                        {txType === 'spend' ? 'Spend' : 'Receive'}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Amount</span>
                      <span className="tabular-nums font-bold text-amber-500">
                        {amountNum > 0 ? formatMoney(amountNum) : '—'}
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
                    className="w-full mt-6 py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
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
