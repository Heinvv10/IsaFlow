/**
 * IRP5 Certificates Page
 * Route: /payroll/irp5
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { formatCurrency } from '@/utils/formatters';
import { FileText, Loader2, AlertCircle, Download, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Irp5CertRow {
  employee_id: string; employee_number: string;
  first_name: string; last_name: string;
  id_number: string | null; tax_number: string | null;
  total_gross_income: number; total_paye: number;
  total_uif_employee: number; total_uif_employer: number;
  total_net_pay: number; certificate_number: string;
}

interface Irp5Response { taxYear: number; certificates: Irp5CertRow[] }

function getCurrentTaxYear(): number {
  const now = new Date();
  return now.getMonth() >= 2 ? now.getFullYear() + 1 : now.getFullYear();
}

function doExportCsv(certs: Irp5CertRow[], yr: number) {
  const esc = (v: string | number | null | undefined) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const hdr = 'Certificate Number,Employee Number,Surname,First Name,ID Number,Tax Number,Gross Income,PAYE,UIF Employee,UIF Employer,Net Pay';
  const rows = certs.map(c =>
    [c.certificate_number, c.employee_number, esc(c.last_name), esc(c.first_name),
     c.id_number ?? '', c.tax_number ?? '', c.total_gross_income, c.total_paye,
     c.total_uif_employee, c.total_uif_employer, c.total_net_pay].join(',')
  );
  const blob = new Blob([[hdr, ...rows].join('\r\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `IRP5_Certificates_${yr}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function Card({ label, amount, accent = false }: { label: string; amount: number; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${accent ? 'border-teal-500/40 bg-teal-500/10' : 'border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]'}`}>
      <p className="text-xs text-[var(--ff-text-secondary)] uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-xl font-semibold font-mono ${accent ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>{formatCurrency(amount)}</p>
    </div>
  );
}

export default function Irp5Page() {
  const TAX_YEARS = [2024, 2025, 2026, 2027];
  const [taxYear, setTaxYear] = useState(getCurrentTaxYear());
  const [data, setData] = useState<Irp5Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadCerts = useCallback(async (yr: number) => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/payroll/irp5-certificates?taxYear=${yr}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: Irp5Response };
      setData(json.data);
    } catch { setError('Failed to load IRP5 data'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCerts(taxYear); }, [taxYear, loadCerts]);

  async function handleGenerate() {
    setGenerating(true); setError(''); setSuccessMsg('');
    try {
      const res = await apiFetch('/api/payroll/irp5-certificates?action=generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taxYear }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as { data: Irp5Response };
      setData(json.data);
      setSuccessMsg(`Generated ${json.data.certificates.length} certificate(s) for ${taxYear}`);
    } catch { setError('Failed to generate IRP5 certificates'); }
    finally { setGenerating(false); }
  }

  const certs = data?.certificates ?? [];
  const totalGross  = certs.reduce((s, c) => s + c.total_gross_income, 0);
  const totalPaye   = certs.reduce((s, c) => s + c.total_paye, 0);
  const totalUif    = certs.reduce((s, c) => s + c.total_uif_employee + c.total_uif_employer, 0);
  const totalNet    = certs.reduce((s, c) => s + c.total_net_pay, 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><FileText className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">IRP5 Certificates</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Annual employee tax certificates for SARS submission</p>
              </div>
            </div>
            <div className="flex items-center gap-2 print:hidden">
              <button onClick={handleGenerate} disabled={generating}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Generate IRP5s
              </button>
              {certs.length > 0 && (
                <>
                  <button onClick={() => doExportCsv(certs, taxYear)}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)] text-sm font-medium transition-colors">
                    <Download className="h-4 w-4" /> Export CSV
                  </button>
                  <button onClick={() => window.print()}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)] text-sm font-medium transition-colors">
                    Download All (PDF)
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="flex items-center gap-4 flex-wrap print:hidden">
            <label className="text-sm font-medium text-[var(--ff-text-secondary)]">Tax Year:</label>
            <select value={taxYear} onChange={e => setTaxYear(Number(e.target.value))}
              className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500/50">
              {TAX_YEARS.map(y => <option key={y} value={y}>{y} (Mar {y - 1} – Feb {y})</option>)}
            </select>
            {successMsg && <span className="text-sm text-teal-400">{successMsg}</span>}
          </div>

          {error && <div className="flex items-center gap-2 text-red-400"><AlertCircle className="h-5 w-5" /><span className="text-sm">{error}</span></div>}

          {!loading && certs.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Card label="Gross Income" amount={totalGross} />
              <Card label="Total PAYE" amount={totalPaye} />
              <Card label="Total UIF" amount={totalUif} />
              <Card label="Net Pay" amount={totalNet} accent />
            </div>
          )}

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Certificates — Tax Year {taxYear}</h2>
              {!loading && <span className="text-sm text-[var(--ff-text-secondary)]">{certs.length} employee{certs.length !== 1 ? 's' : ''}</span>}
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-teal-500" /></div>
            ) : certs.length === 0 ? (
              <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] py-12 text-center">
                <FileText className="h-10 w-10 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
                <p className="text-sm text-[var(--ff-text-secondary)]">No IRP5 data for {taxYear}.</p>
                <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">Click Generate IRP5s to compute certificates from completed payroll runs.</p>
              </div>
            ) : (
              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-auto bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      {['Employee', 'ID / Tax No.', 'Gross Income', 'PAYE', 'UIF', 'Net Pay', 'Certificate #'].map((h, i) => (
                        <th key={h} className={`py-3 px-4 text-[var(--ff-text-secondary)] font-medium ${i > 1 && i < 6 ? 'text-right' : 'text-left'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {certs.map(c => (
                      <tr key={c.employee_id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                        <td className="py-3 px-4">
                          <p className="font-medium text-[var(--ff-text-primary)]">{c.last_name}, {c.first_name}</p>
                          <p className="text-xs text-[var(--ff-text-tertiary)]">{c.employee_number}</p>
                        </td>
                        <td className="py-3 px-4 text-xs text-[var(--ff-text-secondary)]">
                          <p>{c.id_number ?? '—'}</p><p className="text-[var(--ff-text-tertiary)]">{c.tax_number ?? '—'}</p>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(c.total_gross_income)}</td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(c.total_paye)}</td>
                        <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(c.total_uif_employee + c.total_uif_employer)}</td>
                        <td className="py-3 px-4 text-right font-mono text-teal-400">{formatCurrency(c.total_net_pay)}</td>
                        <td className="py-3 px-4 text-xs text-[var(--ff-text-tertiary)] font-mono">{c.certificate_number}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <td colSpan={2} className="py-3 px-4 font-semibold text-[var(--ff-text-primary)]">Totals</td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--ff-text-primary)]">{formatCurrency(totalGross)}</td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--ff-text-primary)]">{formatCurrency(totalPaye)}</td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-[var(--ff-text-primary)]">{formatCurrency(totalUif)}</td>
                      <td className="py-3 px-4 text-right font-mono font-semibold text-teal-400">{formatCurrency(totalNet)}</td>
                      <td className="py-3 px-4" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
          <p className="text-xs text-[var(--ff-text-tertiary)]">IRP5 covers SA tax year Mar {taxYear - 1} – Feb {taxYear}. Submit to SARS via e@syFile Employer.</p>
        </div>
      </div>
    </AppLayout>
  );
}
