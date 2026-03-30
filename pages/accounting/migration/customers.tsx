import { useState, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Upload, Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import Papa from 'papaparse';

const CUSTOMER_FIELDS = [
  'name', 'email', 'phone', 'vat_number', 'registration_number',
  'billing_address', 'contact_person', 'payment_terms', 'credit_limit', 'notes',
] as const;
type CustomerField = typeof CUSTOMER_FIELDS[number];

type FieldMapping = Partial<Record<CustomerField, string>>;
type DuplicateStrategy = 'skip' | 'overwrite' | 'merge';

interface ParsedCustomer {
  raw: Record<string, string>;
  mapped: Partial<Record<CustomerField, string>>;
  isDuplicate?: boolean;
}

interface ImportResult {
  succeeded: number;
  failed: number;
  skipped: number;
}

export default function CustomersImportPage() {
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedCustomer[]>([]);
  const [fieldMapping, setFieldMapping] = useState<FieldMapping>({});
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('skip');
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    setError('');
    setImportResult(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, meta }) => {
        const cols = meta.fields ?? [];
        setColumns(cols);
        const autoMapping: FieldMapping = {};
        for (const field of CUSTOMER_FIELDS) {
          const match = cols.find(c => c.toLowerCase().replace(/[\s_-]/g, '') === field.replace(/_/g, ''));
          if (match) autoMapping[field] = match;
        }
        setFieldMapping(autoMapping);
        setRows(data.map(raw => ({
          raw,
          mapped: Object.fromEntries(
            CUSTOMER_FIELDS.filter(f => autoMapping[f]).map(f => [f, raw[autoMapping[f]!] ?? ''])
          ) as Partial<Record<CustomerField, string>>,
        })));
      },
      error: err => setError(`CSV parse error: ${err.message}`),
    });
  };

  const onFieldMapChange = (field: CustomerField, col: string) => {
    const updated = { ...fieldMapping, [field]: col };
    setFieldMapping(updated);
    setRows(prev => prev.map(r => ({
      ...r,
      mapped: Object.fromEntries(
        CUSTOMER_FIELDS.filter(f => updated[f]).map(f => [f, r.raw[updated[f]!] ?? ''])
      ) as Partial<Record<CustomerField, string>>,
    })));
  };

  const handleImport = async () => {
    setIsImporting(true);
    setError('');
    try {
      const sessionRes = await apiFetch('/api/accounting/migration/session');
      const sessionJson = await sessionRes.json();
      const sessionId = sessionJson.data?.id;
      if (!sessionId) throw new Error('No active migration session');

      const customers = rows.map(r => ({
        name: r.mapped.name ?? '',
        email: r.mapped.email,
        phone: r.mapped.phone,
        vatNumber: r.mapped.vat_number,
        registrationNumber: r.mapped.registration_number,
        billingAddress: r.mapped.billing_address,
        contactPerson: r.mapped.contact_person,
        paymentTerms: r.mapped.payment_terms ? parseInt(r.mapped.payment_terms, 10) : undefined,
        creditLimit: r.mapped.credit_limit ? parseFloat(r.mapped.credit_limit) : undefined,
        notes: r.mapped.notes,
      }));

      const res = await apiFetch('/api/accounting/migration/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, customers, duplicateStrategy }),
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
    const res = await apiFetch('/api/accounting/migration/templates?step=customers');
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'customers-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/accounting/migration" className="flex items-center gap-2 text-blue-600 hover:text-blue-800 mb-6 text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Migration Hub
        </Link>
        <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-2">Customer Import</h1>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-6">Import customer records from a CSV file.</p>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}
        {importResult && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm mb-4">
            <CheckCircle2 className="h-4 w-4" />
            Imported {importResult.succeeded} customers. Skipped: {importResult.skipped}. Failed: {importResult.failed}.
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
                {CUSTOMER_FIELDS.map(field => (
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
                <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">4. Duplicate Handling</h2>
                <div className="flex gap-4">
                  {(['skip', 'overwrite', 'merge'] as DuplicateStrategy[]).map(s => (
                    <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="duplicateStrategy"
                        value={s}
                        checked={duplicateStrategy === s}
                        onChange={() => setDuplicateStrategy(s)}
                        className="text-blue-600"
                      />
                      <span className="text-[var(--ff-text-primary)] capitalize">{s}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">5. Preview ({rows.length} rows)</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs divide-y divide-gray-200 dark:divide-gray-700">
                    <thead>
                      <tr className="bg-[var(--ff-bg-primary)]">
                        {CUSTOMER_FIELDS.filter(f => fieldMapping[f]).map(f => (
                          <th key={f} className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">{f}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {rows.slice(0, 10).map((r, i) => (
                        <tr key={i} className={r.isDuplicate ? 'bg-amber-500/5' : ''}>
                          {CUSTOMER_FIELDS.filter(f => fieldMapping[f]).map(f => (
                            <td key={f} className="px-3 py-1.5 text-[var(--ff-text-primary)]">{r.mapped[f] ?? ''}</td>
                          ))}
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
                  Import {rows.length} Customers
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
