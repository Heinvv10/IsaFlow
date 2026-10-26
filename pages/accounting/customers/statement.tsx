/**
 * Customer Statement Page
 * Route: /accounting/customers/statement
 *
 * Date-range customer statement with PDF download.
 * Sage equivalent: Customers > Statements > Generate Statement
 */

import { useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft,
  FileText,
  Download,
  Loader2,
  AlertCircle,
  Search,
  ClipboardList,
  ExternalLink,
} from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import {
  CustomerStatementPreview, type Customer, type StatementResult,
} from '@/components/accounting/statements/CustomerStatementPreview';
import { DateField } from '@/components/ui/DateField';

export default function CustomerStatementPage() {
  // Form state
  // Local calendar dates: toISOString() is UTC and names yesterday before 02:00 SAST.
  const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localISODate(d); };
  const today = localISODate();
  const oneYearAgo = daysAgo(365);

  const [fromDate, setFromDate] = useState(oneYearAgo);
  const [toDate, setToDate] = useState(today);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statement, setStatement] = useState<StatementResult | null>(null);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  // Customer search with debounce
  const searchCustomers = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) { setCustomerResults([]); return; }
    setSearching(true);
    try {
      const res = await apiFetch(`/api/accounting/customers?q=${encodeURIComponent(q)}`, { credentials: 'include' });
      await assertOk(res, 'Could not search customers - try again');
      const json = await res.json();
      setError('');
      setCustomerResults((json.data || []).slice(0, 10));
    } catch (err) { setCustomerResults([]); setError(apiErrorMessage(err, 'Could not search customers - try again')); }
    finally { setSearching(false); }
  }, []);

  const handleSearchChange = (val: string) => {
    setCustomerSearch(val);
    if (selectedCustomer) { setSelectedCustomer(null); setStatement(null); }
    void searchCustomers(val);
  };

  const selectCustomer = (c: Customer) => {
    setSelectedCustomer(c);
    setCustomerSearch(c.name);
    setCustomerResults([]);
    setStatement(null);
  };

  const handlePreview = async () => {
    if (!selectedCustomer) { setError('Please select a customer'); return; }
    setLoading(true);
    setError('');
    setStatement(null);
    try {
      const params = new URLSearchParams({
        customerId: selectedCustomer.id,
        fromDate,
        toDate,
      });
      const res = await apiFetch(`/api/accounting/customer-statement?${params}`, { credentials: 'include' });
      await assertOk(res, 'Could not load the statement - try again');
      const json = await res.json();
      setStatement(json.data);
    } catch (err) {
      setStatement(null);
      setError(apiErrorMessage(err, 'Could not load the statement - try again'));
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!statement) return;
    setDownloadingPdf(true);
    try {
      // Import the same statementPdf utility used on the detail page
      const { generateStatementPdf } = await import('@/modules/accounting/utils/statementPdf');
      let companyName = '', companyVatNumber = '', companyEmail = '', companyPhone = '', companyAddress = '', accentColor = '#0f766e';
      try {
        const cRes = await apiFetch('/api/accounting/company-details', { credentials: 'include' });
        await assertOk(cRes, 'Could not load your company details for the PDF - try again');
        const cJson = await cRes.json() as { data?: Record<string, string> } & Record<string, string>;
        const c = (cJson.data ?? cJson) as Record<string, string>;
        companyName = c.name || ''; companyVatNumber = c.vat_number || '';
        companyEmail = c.email || ''; companyPhone = c.phone || '';
        companyAddress = c.address || ''; accentColor = c.primary_color || '#0f766e';
      } catch (err) { setError(apiErrorMessage(err, 'Could not load your company details for the PDF - try again')); return; }

      const blob = await generateStatementPdf({
        clientName: statement.customer.name,
        clientEmail: statement.customer.email ?? undefined,
        clientPhone: statement.customer.phone ?? undefined,
        asAtDate: toDate,
        totalInvoiced: statement.summary.totalInvoiced,
        totalPaid: statement.summary.totalPaid,
        totalCredits: statement.summary.totalCredits,
        balanceOutstanding: statement.summary.balance,
        openingBalance: statement.summary.openingBalance,
        transactions: statement.transactions,
        companyName, companyVatNumber, companyEmail, companyPhone, companyAddress, accentColor,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${statement.customer.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-${fromDate}-to-${toDate}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not generate the PDF - try again'));
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handlePrintHtml = () => {
    if (!selectedCustomer) return;
    const params = new URLSearchParams({
      customerId: selectedCustomer.id,
      fromDate,
      toDate,
      format: 'pdf',
    });
    window.open(`/api/accounting/customer-statement?${params}`, '_blank');
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/customer-statements"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-purple-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Customer Statements
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <ClipboardList className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Generate Statement</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Customer statement with running balance for a date range
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6 max-w-5xl">
          {/* Filter Bar */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Statement Parameters</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Customer Picker */}
              <div className="md:col-span-1 relative">
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Customer *</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
                  <input
                    type="text"
                    name="search"
                    placeholder="Type to search..."
                    value={customerSearch}
                    onChange={e => handleSearchChange(e.target.value)}
                    className="ff-input w-full pl-9"
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-[var(--ff-text-tertiary)]" />
                  )}
                </div>
                {customerResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 z-10 mt-1 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {customerResults.map(c => (
                      <button key={c.id} onClick={() => selectCustomer(c)}
                        className="w-full text-left px-4 py-2.5 text-sm hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]">
                        {c.name}
                        {c.email && <span className="ml-2 text-xs text-[var(--ff-text-tertiary)]">{c.email}</span>}
                      </button>
                    ))}
                  </div>
                )}
                {selectedCustomer && (
                  <p className="text-xs text-teal-400 mt-1">Selected: {selectedCustomer.name}</p>
                )}
              </div>

              {/* Date Range */}
              <div>
                <DateField label="From Date" name="dateFrom" required value={fromDate || null}
                  onChange={(iso, v) => { if (v.valid && iso) setFromDate(iso); }} />
              </div>
              <div>
                <DateField label="To Date" name="dateTo" required value={toDate || null}
                  onChange={(iso, v) => { if (v.valid && iso) setToDate(iso); }} />
              </div>
            </div>

            {/* Quick date presets */}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              <span className="text-xs text-[var(--ff-text-tertiary)]">Quick:</span>
              {[
                { label: 'This Month', from: today.substring(0, 7) + '-01', to: today },
                { label: 'Last 3 Months', from: daysAgo(90), to: today },
                { label: 'Last 6 Months', from: daysAgo(180), to: today },
                { label: 'Last 12 Months', from: oneYearAgo, to: today },
              ].map(preset => (
                <button key={preset.label}
                  onClick={() => { setFromDate(preset.from); setToDate(preset.to); setStatement(null); }}
                  className="px-2 py-1 text-xs rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-[var(--ff-border-light)]">
              <button onClick={handlePreview} disabled={loading || !selectedCustomer}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-50">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {loading ? 'Loading...' : 'Preview Statement'}
              </button>

              {statement && (
                <>
                  <button onClick={handleDownloadPdf} disabled={downloadingPdf}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg text-sm disabled:opacity-50">
                    {downloadingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    {downloadingPdf ? 'Generating...' : 'Download PDF'}
                  </button>
                  <button onClick={handlePrintHtml}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg text-sm">
                    <ExternalLink className="h-4 w-4" />
                    Print / Save PDF
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}

          {/* Statement Preview */}
          {statement && (
            <CustomerStatementPreview statement={statement} />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
