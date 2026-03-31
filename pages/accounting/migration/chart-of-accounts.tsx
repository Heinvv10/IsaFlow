import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Upload, Download, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const COA_FIELDS = ['account_code', 'account_name', 'account_type', 'normal_balance', 'parent_code', 'description'] as const;
type CoaField = typeof COA_FIELDS[number];

const SYSTEM_ACCOUNT_ROLES = [
  { key: 'bank', label: 'Primary Bank Account' },
  { key: 'receivable', label: 'Accounts Receivable' },
  { key: 'payable', label: 'Accounts Payable' },
  { key: 'vat_input', label: 'VAT Input (Claimable)' },
  { key: 'vat_output', label: 'VAT Output (Payable)' },
  { key: 'retained_earnings', label: 'Retained Earnings' },
  { key: 'default_revenue', label: 'Default Revenue' },
  { key: 'default_expense', label: 'Default Expense' },
  { key: 'admin_expense', label: 'Admin / General Expense' },
] as const;

type SystemAccountRole = typeof SYSTEM_ACCOUNT_ROLES[number]['key'];

const AUTO_DETECT_PATTERNS: Record<SystemAccountRole, string[]> = { bank: ['bank', 'cheque', 'current account', 'fnb', 'absa', 'nedbank', 'standard bank', 'capitec'], receivable: ['receivable', 'debtors', 'trade debtors'], payable: ['payable', 'creditors', 'trade creditors'], vat_input: ['vat input', 'input tax', 'vat claimable'], vat_output: ['vat output', 'output tax', 'vat payable'], retained_earnings: ['retained earnings', 'retained profit'], default_revenue: ['sales revenue', 'revenue', 'income', 'turnover'], default_expense: ['cost of sales', 'cost of goods', 'materials'], admin_expense: ['admin', 'general expenses', 'administration'] };

interface ParsedRow {
  raw: Record<string, string>;
  mapped: Partial<Record<CoaField, string>>;
}

type FieldMapping = Partial<Record<CoaField, string>>;
type SystemAccountMap = Partial<Record<SystemAccountRole, string>>;

export default function ChartOfAccountsPage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sourceSystem, setSourceSystem] = useState<string>('other');
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [fieldMapping, setFieldMapping] = useState<FieldMapping>({});
  const [systemMap, setSystemMap] = useState<SystemAccountMap>({});
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ succeeded: number; failed: number } | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch('/api/accounting/migration/session').then(async res => {
      if (!res.ok) return;
      const json = await res.json();
      if (json.data) {
        setSessionId(json.data.id);
        setSourceSystem(json.data.sourceSystem ?? 'other');
      }
    }).catch(() => {});
  }, []);

  const applyAutoDetect = useCallback((parsedRows: ParsedRow[], mapping: FieldMapping) => {
    const nameField = mapping.account_name;
    if (!nameField) return;
    const detected: SystemAccountMap = {};
    for (const { key } of SYSTEM_ACCOUNT_ROLES) {
      const patterns = AUTO_DETECT_PATTERNS[key as SystemAccountRole];
      const match = parsedRows.find(r => {
        const name = (r.raw[nameField] ?? '').toLowerCase();
        return patterns.some(p => name.includes(p));
      });
      if (match) {
        const codeField = mapping.account_code;
        detected[key as SystemAccountRole] = codeField ? (match.raw[codeField] ?? '') : '';
      }
    }
    setSystemMap(detected);
  }, []);

  const handleFile = async (file: File) => {
    setError('');
    setImportResult(null);
    const Papa = (await import('papaparse')).default;
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data, meta }) => {
        const cols = meta.fields ?? [];
        setColumns(cols);
        const autoMapping: FieldMapping = {};
        for (const field of COA_FIELDS) {
          const match = cols.find(c => c.toLowerCase().replace(/[\s_-]/g, '') === field.replace(/_/g, ''));
          if (match) autoMapping[field] = match;
        }
        setFieldMapping(autoMapping);
        const parsed: ParsedRow[] = data.map(raw => ({
          raw,
          mapped: Object.fromEntries(
            COA_FIELDS.filter(f => autoMapping[f]).map(f => [f, raw[autoMapping[f]!] ?? ''])
          ) as Partial<Record<CoaField, string>>,
        }));
        setRows(parsed);
        applyAutoDetect(parsed, autoMapping);
      },
      error: err => setError(`CSV parse error: ${err.message}`),
    });
  };

  const onFieldMapChange = (field: CoaField, col: string) => {
    const updated = { ...fieldMapping, [field]: col };
    setFieldMapping(updated);
    const reMapped: ParsedRow[] = rows.map(r => ({
      ...r,
      mapped: Object.fromEntries(
        COA_FIELDS.filter(f => updated[f]).map(f => [f, r.raw[updated[f]!] ?? ''])
      ) as Partial<Record<CoaField, string>>,
    }));
    setRows(reMapped);
    applyAutoDetect(reMapped, updated);
  };

  const handleImport = async () => {
    if (!sessionId) { setError('No active migration session'); return; }
    setIsImporting(true);
    setError('');
    try {
      const accounts = rows.map(r => ({
        accountCode: r.mapped.account_code ?? '',
        accountName: r.mapped.account_name ?? '',
        accountType: r.mapped.account_type ?? '',
        normalBalance: r.mapped.normal_balance ?? 'debit',
        parentCode: r.mapped.parent_code,
        description: r.mapped.description,
      }));
      const res = await apiFetch('/api/accounting/migration/chart-of-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, accounts, systemAccountMap: systemMap }),
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
    const res = await apiFetch(`/api/accounting/migration/templates?sourceSystem=${sourceSystem}&step=chart-of-accounts`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coa-template-${sourceSystem}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Link href="/accounting/migration" className="flex items-center gap-2 text-blue-600 hover:text-blue-800 mb-6 text-sm">
          <ArrowLeft className="h-4 w-4" /> Back to Migration Hub
        </Link>
        <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-2">Chart of Accounts Import</h1>
        <p className="text-sm text-[var(--ff-text-secondary)] mb-6">Upload your existing chart of accounts as a CSV file.</p>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}

        {importResult && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm mb-4">
            <CheckCircle2 className="h-4 w-4" />
            Imported {importResult.succeeded} accounts{importResult.failed > 0 ? `, ${importResult.failed} failed` : ''}.
          </div>
        )}

        <div className="space-y-6">
          {/* Download template */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
            <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">1. Download Template</h2>
            <button onClick={downloadTemplate} className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm">
              <Download className="h-4 w-4" /> Download CSV Template
            </button>
          </div>

          {/* Upload */}
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

          {/* Field mapping */}
          {columns.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">3. Map Columns</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {COA_FIELDS.map(field => (
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

          {/* Preview table */}
          {rows.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="font-semibold text-[var(--ff-text-primary)] mb-3">4. Preview ({rows.length} rows)</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-xs divide-y divide-gray-200 dark:divide-gray-700">
                  <thead>
                    <tr className="bg-[var(--ff-bg-primary)]">
                      {COA_FIELDS.filter(f => fieldMapping[f]).map(f => (
                        <th key={f} className="px-3 py-2 text-left text-[var(--ff-text-secondary)] font-medium">{f}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {rows.slice(0, 10).map((r, i) => (
                      <tr key={i}>
                        {COA_FIELDS.filter(f => fieldMapping[f]).map(f => (
                          <td key={f} className="px-3 py-1.5 text-[var(--ff-text-primary)]">{r.mapped[f] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 10 && <p className="text-xs text-[var(--ff-text-tertiary)] mt-2">... and {rows.length - 10} more rows</p>}
            </div>
          )}

          {/* System account mapping */}
          {rows.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
              <h2 className="font-semibold text-[var(--ff-text-primary)] mb-1">5. Map System Accounts</h2>
              <p className="text-xs text-[var(--ff-text-secondary)] mb-4">ISAFlow needs to know which accounts serve these system roles.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {SYSTEM_ACCOUNT_ROLES.map(({ key, label }) => (
                  <div key={key}>
                    <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">{label}</label>
                    <select
                      value={systemMap[key as SystemAccountRole] ?? ''}
                      onChange={e => setSystemMap(prev => ({ ...prev, [key]: e.target.value }))}
                      className="w-full text-sm border border-[var(--ff-border-light)] rounded px-2 py-1.5 bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]"
                    >
                      <option value="">-- select --</option>
                      {rows.map((r, i) => {
                        const code = fieldMapping.account_code ? r.raw[fieldMapping.account_code] ?? '' : '';
                        const name = fieldMapping.account_name ? r.raw[fieldMapping.account_name] ?? '' : '';
                        return <option key={i} value={code}>{code} - {name}</option>;
                      })}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Import */}
          {rows.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={handleImport}
                disabled={isImporting || !sessionId}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Import {rows.length} Accounts
              </button>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
