import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { fmtDate } from '@/lib/fmtDate';
import { ArrowLeft, ClipboardList, Loader2, AlertCircle, Download, FileText, Search, ExternalLink } from 'lucide-react';
// generateStatementPdf is loaded dynamically inside handleDownloadPDF
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { TypeBadge, getTransactionUrl, type SupplierInfo, type Summary } from '@/components/accounting/supplierStatementParts';

interface Transaction {
  id: number | string;
  date: string;
  type: 'invoice' | 'payment' | 'debit_note';
  reference: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
}

type TypeFilter = 'all' | 'invoice' | 'payment' | 'debit_note';

export default function SupplierStatementDetailPage() {
  const router = useRouter();
  const supplierId = router.query.supplierId as string;
  const asAtDate = typeof router.query.as_at_date === 'string' ? router.query.as_at_date : fmtDate(new Date());

  const [supplier, setSupplier] = useState<SupplierInfo | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  const load = useCallback(async () => {
    if (!supplierId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-statement-detail?supplier_id=${supplierId}&as_at_date=${encodeURIComponent(asAtDate)}`);
      await assertOk(res, 'Failed to load supplier statement');
      const json = await res.json();
      const data = json.data || json;
      setSupplier(data.supplier || null);
      setTransactions(data.transactions || []);
      setSummary(data.summary || null);
    } catch {
      setError('Failed to load supplier statement');
    } finally {
      setIsLoading(false);
    }
  }, [supplierId, asAtDate]);

  useEffect(() => { void load(); }, [load]);

  const filteredTransactions = useMemo(() => {
    let filtered = transactions;
    if (typeFilter !== 'all') {
      filtered = filtered.filter(t => t.type === typeFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(t =>
        t.reference.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
      );
    }
    return filtered;
  }, [transactions, search, typeFilter]);

  function handleExportCSV() {
    if (!supplier || transactions.length === 0) return;
    const header = 'Date,Type,Reference,Description,Debit,Credit,Balance';
    const rows = transactions.map(t =>
      [formatDate(t.date), t.type, `"${t.reference}"`, `"${(t.description || '').replace(/"/g, '""')}"`,
       t.debit.toFixed(2), t.credit.toFixed(2), t.balance.toFixed(2)].join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `supplier-statement-${supplier.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDownloadPDF() {
    if (!supplier || !summary || transactions.length === 0) return;
    const { generateStatementPdf } = await import('@/modules/accounting/utils/statementPdf');
    let companyName = '', companyVatNumber = '', companyEmail = '', companyPhone = '', companyAddress = '', accentColor = '#0d9488';
    try {
      const cRes = await apiFetch('/api/accounting/company-details');
      const cJson = await cRes.json() as { data?: Record<string, string> } & Record<string, string>;
      const c = (cJson.data ?? cJson) as Record<string, string>;
      companyName = c.name || ''; companyVatNumber = c.vat_number || '';
      companyEmail = c.email || ''; companyPhone = c.phone || '';
      companyAddress = c.address || ''; accentColor = c.primary_color || '#0d9488';
    } catch { /* use defaults */ }

    const blob = await generateStatementPdf({
      clientName: supplier.name,
      clientEmail: supplier.email || undefined,
      clientPhone: supplier.phone || undefined,
      asAtDate,
      totalInvoiced: summary.totalInvoiced,
      totalPaid: summary.totalPaid,
      totalCredits: summary.totalReturns,
      balanceOutstanding: summary.balance,
      transactions: transactions.map(t => ({
        ...t,
        type: t.type === 'debit_note' ? 'credit_note' as const : t.type,
      })),
      companyName, companyVatNumber, companyEmail, companyPhone, companyAddress, accentColor,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `supplier-statement-${supplier.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const typeButtons: { label: string; value: TypeFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Invoices', value: 'invoice' },
    { label: 'Payments', value: 'payment' },
    { label: 'Debit Notes', value: 'debit_note' },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Link href={`/accounting/supplier-statements?as_at_date=${asAtDate}`} className="p-3 rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors" title="Back to Supplier Statements">
                  <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" aria-hidden="true" />
                  <span className="sr-only">Back to Supplier Statements</span>
                </Link>
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <ClipboardList className="h-6 w-6 text-orange-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    {supplier?.name || 'Supplier Statement'}
                  </h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">AP transaction history as at {asAtDate}</p>
                </div>
              </div>
              {transactions.length > 0 && (
                <div className="flex items-center gap-2">
                  <button onClick={handleDownloadPDF}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 text-sm font-medium">
                    <FileText className="h-4 w-4" /> PDF
                  </button>
                  <button onClick={handleExportCSV}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-sm font-medium">
                    <Download className="h-4 w-4" /> CSV
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : (
            <>
              {summary && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: 'Total Invoiced', value: summary.totalInvoiced, color: 'blue' },
                    { label: 'Total Paid', value: summary.totalPaid, color: 'teal' },
                    { label: 'Returns/Credits', value: summary.totalReturns, color: 'amber' },
                    { label: 'Balance Owing', value: summary.balance, color: summary.balance > 0 ? 'red' : 'teal' },
                  ].map(card => (
                    <div key={card.label} className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                      <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">{card.label}</p>
                      <p className={`text-xl font-bold text-${card.color}-400`}>{formatCurrency(card.value)}</p>
                    </div>
                  ))}
                </div>
              )}

              {transactions.length === 0 ? (
                <div className="text-center py-12 text-[var(--ff-text-secondary)]">
                  No transactions found for this supplier
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="relative flex-1 min-w-[200px] max-w-sm">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
                      <input
                        type="text"
                        name="search"
                        placeholder="Search reference or description..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm placeholder:text-[var(--ff-text-tertiary)]"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      {typeButtons.map(btn => (
                        <button
                          key={btn.value}
                          onClick={() => setTypeFilter(btn.value)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                            typeFilter === btn.value
                              ? 'bg-orange-500/20 text-orange-400'
                              : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
                          }`}
                        >
                          {btn.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Date</th>
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Type</th>
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Reference</th>
                          <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Description</th>
                          <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Debit</th>
                          <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Credit</th>
                          <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Balance</th>
                          <th className="w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTransactions.map((txn, i) => {
                          const url = getTransactionUrl(txn);
                          return (
                            <tr key={`${txn.type}-${txn.reference}-${i}`}
                              onClick={url ? () => router.push(url) : undefined}
                              className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] ${url ? 'cursor-pointer' : ''}`}>
                              <td className="px-4 py-3 text-[var(--ff-text-secondary)] whitespace-nowrap">{formatDate(txn.date)}</td>
                              <td className="px-4 py-3"><TypeBadge type={txn.type} /></td>
                              <td className="px-4 py-3 font-mono text-[var(--ff-text-primary)]">{txn.reference}</td>
                              <td className="px-4 py-3 text-[var(--ff-text-tertiary)] max-w-[240px] truncate">{txn.description || '-'}</td>
                              <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">
                                {txn.debit > 0 ? formatCurrency(txn.debit) : ''}
                              </td>
                              <td className={`px-4 py-3 text-right font-mono ${txn.type === 'payment' ? 'text-teal-400' : 'text-amber-400'}`}>
                                {txn.credit > 0 ? formatCurrency(txn.credit) : ''}
                              </td>
                              <td className={`px-4 py-3 text-right font-mono font-medium ${txn.balance > 0 ? 'text-[var(--ff-text-primary)]' : 'text-teal-400'}`}>
                                {formatCurrency(txn.balance)}
                              </td>
                              <td className="px-2 py-3">
                                {url && <ExternalLink className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {filteredTransactions.length === 0 && (
                      <div className="text-center py-8 text-[var(--ff-text-tertiary)] text-sm">
                        No transactions match your filter
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
