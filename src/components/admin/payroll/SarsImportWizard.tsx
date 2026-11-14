/** XLSX import of a SARS source code release: pick, dry-run preview, import (admin SARS Codes page). */

import { useRef, useState } from 'react';
import { AlertCircle, Loader2, CheckCircle2, FileSpreadsheet, X } from 'lucide-react';
import { assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import type { ImportResult } from './sarsCodeTypes';
import { adminFetch } from '@/lib/admin/adminFetch';

export function ImportWizard({ onClose, onComplete }: { onClose: () => void; onComplete: () => void }) {
  const [step, setStep] = useState<'pick' | 'preview' | 'done'>('pick');
  const [taxYear, setTaxYear] = useState<number>(new Date().getFullYear() + 1);
  const [brsVersion, setBrsVersion] = useState<string>('v25.2.0');
  const [setCurrent, setSetCurrent] = useState<boolean>(true);
  const [file, setFile] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, () => { if (!working) onClose(); }); // audit 4.13

  const submit = async (dryRun: boolean) => {
    if (!file) { setError('Pick an XLSX file first'); return; }
    setWorking(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('taxYear', String(taxYear));
      fd.append('brsVersion', brsVersion);
      fd.append('setCurrent', setCurrent ? '1' : '0');
      if (dryRun) fd.append('dryRun', '1');

      const res = await adminFetch('/api/admin/payroll/sars-codes/import', { method: 'POST', body: fd });
      await assertOk(res, 'Could not import the SARS codes - try again');
      const json = await res.json() as { data?: ImportResult; message?: string };
      setPreview(json.data ?? null);
      setStep(dryRun ? 'preview' : 'done');
      if (!dryRun) setTimeout(onComplete, 1500);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not import the SARS codes - try again'));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="sars-import-title" className="relative w-full max-w-2xl rounded-xl bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] shadow-2xl">
        <div className="px-6 py-4 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
          <h3 id="sars-import-title" className="text-lg font-semibold text-[var(--ff-text-primary)]">Import SARS Codes</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]"><X className="h-5 w-5 text-[var(--ff-text-secondary)]" /></button>
        </div>

        <div className="p-6 space-y-4">
          {step === 'pick' && (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Upload the curated SARS PAYE-AE-06-G06 master XLSX (sheet <span className="font-id">Master_Codes</span>). The 4xxx deduction/employer codes are auto-topped-up from the legacy seed if missing.
              </p>
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">Tax year</span>
                  <input type="number" value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))} className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm" />
                </label>
                <label className="block col-span-2">
                  <span className="text-xs text-[var(--ff-text-tertiary)]">BRS version</span>
                  <input type="text" value={brsVersion} onChange={(e) => setBrsVersion(e.target.value)} placeholder="v25.2.0" className="mt-1 w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm" />
                </label>
              </div>

              <div
                onClick={() => inputRef.current?.click()}
                className="border-2 border-dashed border-[var(--ff-border-primary)] hover:border-teal-500 rounded-lg p-8 text-center cursor-pointer"
              >
                <FileSpreadsheet className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
                <p className="text-sm text-[var(--ff-text-primary)]">{file ? file.name : 'Click to choose XLSX file'}</p>
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Max 5 MB · sheet &quot;Master_Codes&quot; required</p>
                <input ref={inputRef} type="file" accept=".xlsx" aria-label="SARS codes XLSX file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>

              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
                <input type="checkbox" checked={setCurrent} onChange={(e) => setSetCurrent(e.target.checked)} />
                Mark this release as current after import
              </label>

              {error && <div className="flex items-center gap-2 text-sm text-red-400"><AlertCircle className="h-4 w-4" /> {error}</div>}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="px-3 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">Cancel</button>
                <button onClick={() => submit(true)} disabled={working || !file} className="px-3 py-2 rounded-lg text-sm bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)] disabled:opacity-50">
                  {working ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Preview diff'}
                </button>
                <button onClick={() => submit(false)} disabled={working || !file} className="px-3 py-2 rounded-lg text-sm bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50">
                  {working ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Import now'}
                </button>
              </div>
            </>
          )}

          {step === 'preview' && preview && (
            <>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Preview against year {preview.effectiveYear - 1}: <span className="text-[var(--ff-text-primary)] font-medium">{preview.rowCount ?? 0}</span> rows in file.
              </p>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <DiffCell label="Added" value={preview.diff.added.length} color="text-emerald-400" />
                <DiffCell label="Removed" value={preview.diff.removed.length} color="text-red-400" />
                <DiffCell label="Changed" value={preview.diff.changed.length} color="text-amber-400" />
              </div>
              <DiffList title="Added codes" codes={preview.diff.added} />
              <DiffList title="Removed codes" codes={preview.diff.removed} />
              {preview.diff.changed.length > 0 && (
                <div>
                  <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">Changed codes</div>
                  <div className="text-xs text-[var(--ff-text-secondary)] max-h-40 overflow-y-auto rounded bg-[var(--ff-bg-tertiary)] p-2 space-y-1">
                    {preview.diff.changed.map((c, i) => (
                      <div key={i}><span className="font-id">{c.code}</span> {c.field}: <span className="text-red-400 line-through">{c.oldValue ?? '—'}</span> → <span className="text-emerald-400">{c.newValue ?? '—'}</span></div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => { setStep('pick'); setPreview(null); }} className="px-3 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]">Back</button>
                <button onClick={() => submit(false)} disabled={working} className="px-3 py-2 rounded-lg text-sm bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50">
                  {working ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm import'}
                </button>
              </div>
            </>
          )}

          {step === 'done' && preview && (
            <div className="text-center py-6">
              <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
              <p className="text-sm text-[var(--ff-text-primary)]">Imported {preview.upserted} codes for tax year {preview.effectiveYear} (BRS {preview.brsVersion}).</p>
              {preview.setCurrent && <p className="text-xs text-emerald-400 mt-1">Marked as current release.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg bg-[var(--ff-bg-tertiary)] p-3">
      <div className="text-xs text-[var(--ff-text-tertiary)]">{label}</div>
      <div className={`text-2xl tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function DiffList({ title, codes }: { title: string; codes: string[] }) {
  if (codes.length === 0) return null;
  return (
    <div>
      <div className="text-xs text-[var(--ff-text-tertiary)] mb-1">{title}</div>
      <div className="text-xs text-[var(--ff-text-secondary)] flex flex-wrap gap-1 max-h-24 overflow-y-auto rounded bg-[var(--ff-bg-tertiary)] p-2">
        {codes.map((c) => <span key={c} className="font-id px-1 py-0.5 rounded bg-[var(--ff-surface-primary)]">{c}</span>)}
      </div>
    </div>
  );
}
