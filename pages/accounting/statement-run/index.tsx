/**
 * Statement Run — Batch generate and download customer statements
 * Sage equivalent: Customers > Statement Run
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Loader2, AlertCircle, Download, CheckSquare, Square, Mail } from 'lucide-react';
// generateStatementPdf is loaded dynamically inside handleGenerate
import type { StatementData } from '@/modules/accounting/utils/statementPdf';
import { log } from '@/lib/logger';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

interface CustomerBalance {
  client_id: string;
  client_name: string;
  email?: string;
  phone?: string;
  total_invoiced: number;
  total_paid: number;
  balance: number;
  invoice_count: number;
}

export default function StatementRunPage() {
  const [customers, setCustomers] = useState<CustomerBalance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0] ?? '');
  const [minBalance, setMinBalance] = useState(0);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/accounting/customer-statements?as_at_date=${asAtDate}`);
      const json = await res.json();
      const data = json.data || json;
      setCustomers(data.customers || []);
    } catch {
      setError('Failed to load customers');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => { load(); }, [load]);

  const filtered = customers.filter(c => c.balance >= minBalance);

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(c => c.client_id)));
    }
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function handleGenerate() {
    if (selected.size === 0) return;
    setIsGenerating(true);
    try {
      // Load jsPDF-dependent generator once, reuse for all statements in the batch
      const { generateStatementPdf } = await import('@/modules/accounting/utils/statementPdf');
      const pdfs: { name: string; blob: Blob }[] = [];

      for (const clientId of selected) {
        const cust = customers.find(c => c.client_id === clientId);
        if (!cust) continue;

        const detailRes = await fetch(`/api/accounting/customer-statement-detail?client_id=${clientId}`);
        const detailJson = await detailRes.json();
        const detail = detailJson.data || detailJson;

        const stmtData: StatementData = {
          clientName: cust.client_name,
          clientEmail: detail.client?.email || undefined,
          clientPhone: detail.client?.phone || undefined,
          asAtDate,
          totalInvoiced: detail.summary?.totalInvoiced || 0,
          totalPaid: detail.summary?.totalPaid || 0,
          totalCredits: detail.summary?.totalCredits || 0,
          balanceOutstanding: detail.summary?.balance || 0,
          transactions: detail.transactions || [],
        };

        const blob = await generateStatementPdf(stmtData);
        const safeName = cust.client_name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        pdfs.push({ name: `statement-${safeName}.pdf`, blob });
      }

      if (pdfs.length === 1 && pdfs[0]) {
        const url = URL.createObjectURL(pdfs[0].blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = pdfs[0].name;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const { default: JSZip } = await import('jszip');
        const zip = new JSZip();
        for (const pdf of pdfs) {
          zip.file(pdf.name, pdf.blob);
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `statements-${asAtDate}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      log.error('Statement generation failed', { data: err }, 'StatementRun');
      setError('Failed to generate statements');
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <FileText className="h-6 w-6 text-purple-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Statement Run</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Batch generate customer statement PDFs
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleGenerate}
                  disabled={selected.size === 0 || isGenerating}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-50"
                >
                  {isGenerating ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
                  ) : (
                    <><Download className="h-4 w-4" /> Generate {selected.size > 0 ? `(${selected.size})` : ''}</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Filters */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm text-[var(--ff-text-secondary)]">As at:</label>
              <input
                type="date"
                value={asAtDate}
                onChange={e => setAsAtDate(e.target.value)}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-[var(--ff-text-secondary)]">Min balance:</label>
              <input
                type="number"
                value={minBalance}
                onChange={e => setMinBalance(Number(e.target.value))}
                className="w-32 px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
                step={100}
              />
            </div>
            <span className="text-sm text-[var(--ff-text-tertiary)]">
              {filtered.length} customer{filtered.length !== 1 ? 's' : ''} • {selected.size} selected
            </span>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No customers with outstanding balance
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-center px-4 py-3 w-10">
                      <button onClick={toggleAll} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
                        {selected.size === filtered.length ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                      </button>
                    </th>
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Customer</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Invoiced</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Paid</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Balance</th>
                    <th className="text-center px-4 py-3 text-[var(--ff-text-secondary)] font-medium"># Inv</th>
                    <th className="text-center px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(c => (
                    <tr key={c.client_id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="text-center px-4 py-3">
                        <button onClick={() => toggle(c.client_id)} className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
                          {selected.has(c.client_id) ? <CheckSquare className="h-4 w-4 text-purple-400" /> : <Square className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{c.client_name}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{formatCurrency(c.total_invoiced)}</td>
                      <td className="px-4 py-3 text-right text-emerald-400">{formatCurrency(c.total_paid)}</td>
                      <td className="px-4 py-3 text-right font-medium text-[var(--ff-text-primary)]">{formatCurrency(c.balance)}</td>
                      <td className="px-4 py-3 text-center text-[var(--ff-text-secondary)]">{c.invoice_count}</td>
                      <td className="px-4 py-3 text-center">
                        {c.email ? <Mail className="h-4 w-4 text-emerald-400 mx-auto" /> : <span className="text-[var(--ff-text-tertiary)]">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
