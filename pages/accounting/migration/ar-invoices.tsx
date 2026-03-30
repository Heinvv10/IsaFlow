import { useState, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Upload, Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import Papa from 'papaparse';

const AR_FIELDS = [
  'invoice_number', 'customer_name', 'invoice_date', 'due_date',
  'subtotal', 'tax_amount', 'total_amount', 'amount_paid', 'reference',
] as const;
type ArField = typeof AR_FIELDS[number];

type FieldMapping = Partial<Record<ArField, string>>;
type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

interface ParsedInvoice {
  raw: Record<string, string>;
  mapped: Partial<Record<ArField, string>>;
  matchedCustomerId?: string;
  matchConfidence: MatchConfidence;
  overrideCustomerId?: string;
}

interface CustomerOption {
  id: string;
  name: string;
}

interface ImportResult {
  succeeded: number;
  failed: number;
}

export default function ArInvoicesPage() {
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedInvoice[]>([]);
  const [fieldMapping, setFieldMapping] = useState<FieldMapping>({});
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const loadCustomers = async () => {
    try {
      const res = await apiFetch('/api/accounting/customers?limit=500');
      const json = await res.json();
      const list: CustomerOption[] = (json.data ?? json.customers ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }));
      setCustomers(list);
    } catch {
      // Non-fatal
    }
  };

  const fuzzyMatch = (name: string, list: CustomerOption[]): { id?: string; confidence: MatchConfidence } => {
    const n = name.toLowerCase().trim();
    const exact = list.find(c => c.name.toLowerCase().trim() === n);
    if (exact) return { id: exact.id, confidence: 'HIGH' };
    const partial = list.find(c => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()));
    if (partial) return { id: partial.id, confidence: 'MEDIUM' };
    return { confidence: 'NONE' };
  };

  const handleFile = async (file: File) => {
    setError('');
    setImportResult(null);
    if (customers.length === 0) await loadCustomers();
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, meta }) => {
        const cols = meta.fields ?? [];
        setColumns(cols);
        const autoMapping: FieldMapping = {};
        for (const field of AR_FIELDS) {
          const match = cols.find(c => c.toLowerCase().replace(/[\s_-]/g, '') === field.replace(/_/g, ''));
          if (match) autoMapping[field] = match;
        }
        setFieldMapping(autoMapping);
        setRows(data.map(raw => {
          const mapped = Object.fromEntries(
            AR_FIELDS.filter(f => autoMapping[f]).map(f => [f, raw[autoMapping[f]!] ?? ''])
          ) as Partial<Record<ArField, string>>;
          const custName = mapped.customer_name ?? '';
          const { id, confidence } = fuzzyMatch(custName, customers);
          return { raw, mapped, matchedCustomerId: id, matchConfidence: confidence };
        }));
      },
      error: err => setError(`CSV parse error: ${err.message}`),
    });
  };

  const onFieldMapChange = (field: ArField, col: string) => {
    const updated = { ...fieldMapping, [field]: col };
    setFieldMapping(updated);
    setRows(prev => prev.map(r => ({
      ...r,
      mapped: Object.fromEntries(
        AR_FIELDS.filter(f => updated[f]).map(f => [f, r.raw[updated[f]!] ?? ''])
      ) as Partial<Record<ArField, string>>,
    })));
  };

  const setOverride = (i: number, customerId: string) => {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, overrideCustomerId: customerId } : r));
  };

  const handleImport = async () => {
    setIsImporting(true);
    setError('');
    try {
      const sessionRes = await apiFetch('/api/accounting/migration/session');
      const sessionJson = await sessionRes.json();
      const sessionId = sessionJson.data?.id;
      if (!sessionId) throw new Error('No active migration session');

      const invoices = rows.map(r => ({
        invoiceNumber: r.mapped.invoice_number ?? '',
        customerId: r.overrideCustomerId ?? r.matchedCustomerId ?? '',
        customerName: r.mapped.customer_name ?? '',
        invoiceDate: r.mapped.invoice_date ?? '',
        dueDate: r.mapped.due_date ?? '',
        subtotal: parseFloat(r.mapped.subtotal ?? '0') || 0,
        taxAmount: parseFloat(r.mapped.tax_amount ?? '0') || 0,
        totalAmount: parseFloat(r.mapped.total_amount ?? '0') || 0,
        amountPaid: parseFloat(r.mapped.amount_paid ?? '0') || 0,
        reference: r.mapped.reference,
      }));

      const res = await apiFetch('/api/accounting/migration/ar-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, invoices }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Import failed');
      setImportResult(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  const downloadTemplate = async () => {
    const res = await apiFetch('/api/accounting/migration/templates?step=ar-invoices');
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ar-invoices-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const confidenceColor = (c: MatchConfidence) => ({
    HIGH: 'bg-teal-500/20 text-teal-400',
    MEDIUM: 'bg-amber-500/20 text-amber-400',
    LOW: 'bg-orange-500/20 text-orange-400',
    NONE: 'bg-red-500/20 text-red-400',
  }[c]);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/accounting/migration" className="flex items-center gap-2 text-blue-600 hover:text-blue-800 mb-6 text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Migration Hub
        </Link>
        <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-2">Outstanding AR Invoices</h1>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-6">Import outstanding customer invoices from a CSV file.</p>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {importResult && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm mb-4">
            <CheckCircle2 className="h-4 w-4" />
            Imported {importResult.succeeded} invoices. Failed: {importResult.failed}.
          </div>
        )}

        <div className="space-y-6">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">1. Download Template</h2>
            <button onClick={downloadTemplate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              <Download className="h-4 w-4" /> Download CSV Template
            </button>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">2. Upload Your CSV</h2>
            <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 border-2 border-dashed border-[var(--ff-border-light)] rounded-lg text-[var(--ff-text-secondary)] hover:border-blue-500 hover:text-blue-500 text-sm transition-colors"
            >
              <Upload className="h-4 w-4" /> Choose CSV file
            </button>
            {rows.length > 0 && <p className="text-xs text-[var(--ff-text-secondary)] mt-2">{rows.length} rows parsed</p>}
          </div>

          {columns.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">3. Map Columns</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {AR_FIELDS.map(field => (
                  <div key={field}>
                    <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">{field}</label>
                    <select
                      value={fieldMapping[field] ?? ''}
                      onChange={e => onFieldMapChange(field, e.target.value)}
                      className="w-full text-sm border border-[var(--ff-border-light)] rounded px-2 py-1.5 bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]"
                    >
                      <option value="">-- skip --</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">4. Customer Matching Preview</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs divide-y divide-gray-200 dark:divide-gray-700">
                    <thead>
                      <tr className="bg-[var(--ff-bg-primary)]">
                        <th className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">Invoice #</th>
                        <th className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">Customer Name</th>
                        <th className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">Match</th>
                        <th className="px-3 py-2 text-right text-[var(--ff-text-secondary)] font-medium">Total</th>
                        <th className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">Override</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {rows.slice(0, 15).map((r, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1.5 font-mono text-[var(--ff-text-primary)]">{r.mapped.invoice_number ?? ''}</td>
                          <td className="px-3 py-1.5 text-[var(--ff-text-primary)]">{r.mapped.customer_name ?? ''}</td>
                          <td className="px-3 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${confidenceColor(r.matchConfidence)}`}>
                              {r.matchConfidence}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-[var(--ff-text-primary)]">{r.mapped.total_amount ?? ''}</td>
                          <td className="px-3 py-1.5">
                            {r.matchConfidence !== 'HIGH' && (
                              <select
                                value={r.overrideCustomerId ?? ''}
                                onChange={e => setOverride(i, e.target.value)}
                                className="text-xs border border-[var(--ff-border-light)] rounded px-1.5 py-1 bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]"
                              >
                                <option value="">-- select --</option>
                                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                              </select>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleImport}
                  disabled={isImporting}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Import {rows.length} Invoices
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
