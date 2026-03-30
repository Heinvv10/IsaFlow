/**
 * GL Import Wizard — WS-6.3
 * 4-step wizard: Upload → Map Columns → Validate → Import
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import ExcelJS from 'exceljs';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  Upload, ArrowRight, ArrowLeft, CheckCircle2, XCircle,
  FileSpreadsheet, Download, Loader2, BookOpen,
} from 'lucide-react';
import { ValidationStep, ImportStep } from '@/components/accounting/gl-import/GlImportWizardSteps';
import type { ImportRow, ValidationSummary } from '@/modules/accounting/services/glImportService';

type Step = 1 | 2 | 3 | 4;

const REQUIRED_FIELDS = ['date', 'accountCode', 'description', 'debit', 'credit'] as const;
const ALL_FIELDS = [
  { value: '__skip__', label: '— Skip —' },
  { value: 'date', label: 'Date' },
  { value: 'accountCode', label: 'Account Code' },
  { value: 'description', label: 'Description' },
  { value: 'reference', label: 'Reference' },
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit' },
  { value: 'vatCode', label: 'VAT Code' },
  { value: 'costCentre', label: 'Cost Centre' },
];

const AUTO_MAP: Record<string, string> = {
  date: 'date', 'entry date': 'date', 'trans date': 'date',
  'account code': 'accountCode', account: 'accountCode', 'acc code': 'accountCode', code: 'accountCode',
  description: 'description', desc: 'description', narration: 'description', details: 'description',
  reference: 'reference', ref: 'reference',
  debit: 'debit', dr: 'debit',
  credit: 'credit', cr: 'credit',
  'vat code': 'vatCode', vatcode: 'vatCode', 'tax code': 'vatCode',
  'cost centre': 'costCentre', 'cost center': 'costCentre', cc: 'costCentre',
};

function StepIndicator({ current }: { current: Step }) {
  const steps = ['Upload', 'Map Columns', 'Validate', 'Import'];
  return (
    <div className="flex items-center gap-0">
      {steps.map((label, idx) => {
        const num = (idx + 1) as Step;
        const done = current > num;
        const active = current === num;
        return (
          <div key={label} className="flex items-center">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              active ? 'bg-teal-500/20 text-teal-400' :
              done ? 'text-teal-500' : 'text-[var(--ff-text-secondary)]'
            }`}>
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                done ? 'bg-teal-600 text-white' :
                active ? 'bg-teal-500 text-white' : 'bg-[var(--ff-border-light)] text-[var(--ff-text-secondary)]'
              }`}>
                {done ? <CheckCircle2 className="h-4 w-4" /> : num}
              </span>
              {label}
            </div>
            {idx < steps.length - 1 && (
              <ArrowRight className="h-4 w-4 text-[var(--ff-border-light)]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function GlImportPage() {
  const router = useRouter();
  const [isMounted, setIsMounted] = useState(false);
  const [step, setStep] = useState<Step>(1);

  // Step 1 — file
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Step 2 — mapping
  const [mapping, setMapping] = useState<Record<number, string>>({});

  // Step 3 — validation
  const [validating, setValidating] = useState(false);
  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const [validRows, setValidRows] = useState<ImportRow[]>([]);
  const [validateError, setValidateError] = useState('');

  // Step 4 — import
  const [postImmediately, setPostImmediately] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ entriesCreated: number; linesCreated: number; totalValue: number } | null>(null);
  const [importError, setImportError] = useState('');

  useEffect(() => { setIsMounted(true); }, []);

  const parseFile = useCallback((file: File) => {
    setFileError('');
    const name = file.name.toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.csv')) {
      setFileError('Only .xlsx, .xls and .csv files are supported');
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = e.target?.result;
        if (!data) {
          setFileError('Failed to read file contents');
          return;
        }
        const buffer = data instanceof ArrayBuffer ? data : new TextEncoder().encode(data as string).buffer;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buffer);
        const ws = wb.worksheets[0];
        if (!ws) {
          setFileError('File must have at least one sheet');
          return;
        }
        const aoa: string[][] = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const cells = (row.values as (ExcelJS.CellValue | undefined)[]).slice(1);
          aoa.push(cells.map(c => {
            if (c == null) return '';
            if (typeof c === 'object' && 'text' in c) return String((c as ExcelJS.CellRichTextValue).text ?? '');
            if (c instanceof Date) return c.toISOString().slice(0, 10);
            return String(c).trim();
          }));
        });
        if (aoa.length < 2) {
          setFileError('File must have a header row and at least one data row');
          return;
        }
        const headers = (aoa[0] ?? []).map(h => String(h ?? '').trim());
        const dataRows = aoa.slice(1).filter(r => r.some(c => c !== '' && c != null));
        setRawHeaders(headers);
        setRawRows(dataRows.map(r => headers.map((_, i) => String(r[i] ?? '').trim())));
        setFileName(file.name);
        const autoMapping: Record<number, string> = {};
        headers.forEach((h, i) => {
          const key = h.toLowerCase().trim();
          autoMapping[i] = AUTO_MAP[key] ?? '__skip__';
        });
        setMapping(autoMapping);
        setStep(2);
      } catch (err) {
        log.error('Failed to parse spreadsheet', { error: err }, 'gl-import-page');
        setFileError('Failed to read file — make sure it is a valid Excel or CSV file');
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const buildImportRows = useCallback((): ImportRow[] => {
    return rawRows.map(row => {
      const get = (field: string) => {
        const entry = Object.entries(mapping).find(([, v]) => v === field);
        return entry ? (row[Number(entry[0])] ?? '') : '';
      };
      return {
        date: get('date'),
        accountCode: get('accountCode'),
        description: get('description'),
        reference: get('reference') || undefined,
        debit: parseFloat(get('debit').replace(/,/g, '')) || 0,
        credit: parseFloat(get('credit').replace(/,/g, '')) || 0,
        vatCode: get('vatCode') || undefined,
        costCentre: get('costCentre') || undefined,
      };
    });
  }, [rawRows, mapping]);

  const isMappingComplete = REQUIRED_FIELDS.every(f => Object.values(mapping).includes(f));

  const handleValidate = useCallback(async () => {
    setValidating(true);
    setValidateError('');
    setSummary(null);
    try {
      const rows = buildImportRows();
      const res = await apiFetch('/api/accounting/gl-import-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const json = await res.json() as { data: ValidationSummary };
      setSummary(json.data);
      setValidRows(rows.filter((_, i) => json.data.validations[i]?.valid));
      setStep(3);
    } catch (err) {
      log.error('Validation API error', { error: err }, 'gl-import-page');
      setValidateError('Validation failed — please try again');
    } finally {
      setValidating(false);
    }
  }, [buildImportRows]);

  const handleImport = useCallback(async () => {
    setImporting(true);
    setImportError('');
    try {
      const res = await apiFetch('/api/accounting/gl-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: validRows, postImmediately }),
      });
      const json = await res.json() as { data: { entriesCreated: number; linesCreated: number; totalValue: number } };
      setImportResult(json.data);
    } catch (err) {
      log.error('Import API error', { error: err }, 'gl-import-page');
      setImportError('Import failed — please try again');
    } finally {
      setImporting(false);
    }
  }, [validRows, postImmediately]);

  const handleReset = useCallback(() => {
    setStep(1);
    setRawHeaders([]); setRawRows([]); setFileName('');
    setSummary(null); setValidRows([]); setImportResult(null);
    setImportError(''); setValidateError(''); setFileError('');
  }, []);

  if (!isMounted) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">

        {/* Page header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <FileSpreadsheet className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Import Transactions</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Import GL journal entries from Excel or CSV</p>
              </div>
            </div>
            <a
              href="/api/accounting/gl-import-template"
              className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-primary)] transition-colors text-sm"
            >
              <Download className="h-4 w-4" />
              Download Template
            </a>
          </div>
          <div className="px-6 pb-4">
            <StepIndicator current={step} />
          </div>
        </div>

        <div className="px-6 py-6 max-w-5xl mx-auto">

          {/* Step 1: Upload */}
          {step === 1 && (
            <div className="space-y-4">
              <div
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) parseFile(f); }}
                onClick={() => fileRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
                  dragging ? 'border-teal-500 bg-teal-500/5' :
                  'border-[var(--ff-border-light)] hover:border-teal-500/50 hover:bg-[var(--ff-bg-secondary)]'
                }`}
              >
                <Upload className="h-12 w-12 text-[var(--ff-text-secondary)] mx-auto mb-4" />
                <p className="text-lg font-medium text-[var(--ff-text-primary)] mb-1">Drag and drop your file here</p>
                <p className="text-sm text-[var(--ff-text-secondary)]">or click to browse — supports .xlsx, .xls, .csv</p>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) parseFile(f); }} />
              </div>
              {fileError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                  <XCircle className="h-4 w-4 flex-shrink-0" />{fileError}
                </div>
              )}
              <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <BookOpen className="h-4 w-4 text-teal-500" />
                  <span className="text-sm font-medium text-[var(--ff-text-primary)]">Required columns</span>
                </div>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Date, Account Code, Description, Debit, Credit. Optional: Reference, VAT Code, Cost Centre.
                  Download the template above for the correct format.
                </p>
              </div>
            </div>
          )}

          {/* Step 2: Map Columns */}
          {step === 2 && (
            <div className="space-y-6">
              <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-4">
                <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
                  File: <span className="font-medium text-[var(--ff-text-primary)]">{fileName}</span> — {rawRows.length} data rows detected.
                  Map each column to an ISAFlow field. Required fields are marked below.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)]">
                        <th className="text-left pb-2 pr-4 text-[var(--ff-text-secondary)] font-medium">Source Column</th>
                        <th className="text-left pb-2 pr-4 text-[var(--ff-text-secondary)] font-medium">Maps To</th>
                        {rawRows.slice(0, 3).map((_, i) => (
                          <th key={i} className="text-left pb-2 pr-2 text-[var(--ff-text-secondary)] font-medium">Row {i + 1}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rawHeaders.map((header, colIdx) => (
                        <tr key={colIdx} className="border-b border-[var(--ff-border-light)]/50">
                          <td className="py-2 pr-4 font-medium text-[var(--ff-text-primary)]">{header}</td>
                          <td className="py-2 pr-4">
                            <select
                              value={mapping[colIdx] ?? '__skip__'}
                              onChange={e => setMapping(prev => ({ ...prev, [colIdx]: e.target.value }))}
                              className="px-2 py-1 text-sm bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30"
                            >
                              {ALL_FIELDS.map(f => (
                                <option key={f.value} value={f.value}>{f.label}</option>
                              ))}
                            </select>
                          </td>
                          {rawRows.slice(0, 3).map((row, ri) => (
                            <td key={ri} className="py-2 pr-2 text-[var(--ff-text-secondary)] truncate max-w-[120px]">
                              {row[colIdx] ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!isMappingComplete && (
                  <p className="mt-3 text-sm text-amber-400">
                    Required fields not yet mapped: {REQUIRED_FIELDS.filter(f => !Object.values(mapping).includes(f)).join(', ')}
                  </p>
                )}
              </div>
              {validateError && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                  <XCircle className="h-4 w-4 flex-shrink-0" />{validateError}
                </div>
              )}
              <div className="flex items-center justify-between">
                <button onClick={() => setStep(1)} className="inline-flex items-center gap-2 px-4 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-secondary)] transition-colors text-sm">
                  <ArrowLeft className="h-4 w-4" />Back
                </button>
                <button
                  onClick={() => void handleValidate()}
                  disabled={!isMappingComplete || validating}
                  className="inline-flex items-center gap-2 px-5 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
                >
                  {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {validating ? 'Validating...' : 'Validate'}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Validation */}
          {step === 3 && summary && (
            <ValidationStep
              summary={summary}
              onBack={() => setStep(2)}
              onNext={() => setStep(4)}
            />
          )}

          {/* Step 4: Import */}
          {step === 4 && summary && (
            <ImportStep
              validRows={validRows}
              summary={summary}
              postImmediately={postImmediately}
              onPostModeChange={setPostImmediately}
              onBack={() => setStep(3)}
              onImport={() => void handleImport()}
              importing={importing}
              importError={importError}
              importResult={importResult}
              onViewEntries={() => void router.push('/accounting/journal-entries')}
              onReset={handleReset}
            />
          )}

        </div>
      </div>
    </AppLayout>
  );
}
