/**
 * Upload card for an external (Sage/VIP) payslip CSV.
 * Reads the file client-side and POSTs raw CSV text + period as JSON.
 */
import { useRef, useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

interface Props {
  onImported: (importId: string, rowErrors: Array<{ line: number; message: string }>) => void;
}

export function ParallelRunUploadCard({ onImported }: Props) {
  const now = new Date();
  const [periodMonth, setPeriodMonth] = useState(now.getMonth() + 1);
  const [periodYear, setPeriodYear] = useState(now.getFullYear());
  const [source, setSource] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setIsUploading(true);
    setError('');
    try {
      const csvText = await file.text();
      const res = await apiFetch('/api/payroll/parallel-run/imports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvText, periodMonth, periodYear,
          source: source || 'external',
          fileName: file.name,
        }),
      });
      const json = await res.json() as {
        data?: { import?: { id: string }; rowErrors?: Array<{ line: number; message: string }> };
        error?: { message?: string };
        message?: string;
      };
      if (!res.ok || !json.data?.import) {
        throw new Error(json.error?.message ?? json.message ?? `HTTP ${res.status}`);
      }
      onImported(json.data.import.id, json.data.rowErrors ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - 3 + i);

  return (
    <div className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] p-5">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-1">
        Import external payslips
      </h2>
      <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
        CSV with a header row: <code>employee_number</code> plus any of <code>gross, paye,
        uif_employee, uif_employer, uif, sdl, eti, net</code> (VIP/Sage column names are
        recognised). Amounts in rand; blank cells are zero.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-[var(--ff-text-secondary)]">
          Period month
          <select
            value={periodMonth}
            onChange={(e) => setPeriodMonth(Number(e.target.value))}
            className="mt-1 block rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]"
          >
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </label>
        <label className="text-xs text-[var(--ff-text-secondary)]">
          Year
          <select
            value={periodYear}
            onChange={(e) => setPeriodYear(Number(e.target.value))}
            className="mt-1 block rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]"
          >
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label className="text-xs text-[var(--ff-text-secondary)]">
          Source system
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="e.g. VIP Premier"
            className="mt-1 block w-40 rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] px-2 py-1.5 text-sm text-[var(--ff-text-primary)]"
          />
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={isUploading}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--ff-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Choose CSV…
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}
