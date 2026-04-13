/**
 * Statement Run — Batch generate and download customer statements
 * Sage equivalent: Customers > Statement Run
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  FileText,
  Loader2,
  AlertCircle,
  Download,
  Mail,
  SendHorizonal,
} from 'lucide-react';
import { log } from '@/lib/logger';
import { apiFetch } from '@/lib/apiFetch';
import {
  CustomerStatementTable,
  type CustomerBalance,
} from '@/components/accounting/CustomerStatementTable';
import { useStatementEmail } from '@/modules/accounting/hooks/useStatementEmail';
import { generateStatementsBatch } from '@/modules/accounting/utils/generateStatementsBatch';

export default function StatementRunPage() {
  const [customers, setCustomers] = useState<CustomerBalance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [asAtDate, setAsAtDate] = useState(
    new Date().toISOString().split('T')[0] ?? ''
  );
  const [minBalance, setMinBalance] = useState(0);

  const { emailProgress, toast, isSending, emailableCount, sendEmails } =
    useStatementEmail({ customers, asAtDate });

  const filtered = customers.filter(c => c.balance >= minBalance);
  const emailCount = emailableCount(selected);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(
        `/api/accounting/customer-statements?as_at_date=${asAtDate}`
      );
      const json = await res.json();
      const data = json.data || json;
      setCustomers(data.customers || []);
    } catch {
      setError('Failed to load customers');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => {
    load();
  }, [load]);

  function toggleAll() {
    setSelected(
      selected.size === filtered.length
        ? new Set()
        : new Set(filtered.map(c => c.client_id))
    );
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function selectAllWithEmail() {
    setSelected(
      new Set(
        filtered
          .filter(c => c.email && c.balance > 0)
          .map(c => c.client_id)
      )
    );
  }

  async function handleGenerate() {
    if (selected.size === 0) return;
    setIsGenerating(true);
    try {
      await generateStatementsBatch(selected, customers, asAtDate);
    } catch (err) {
      log.error('Statement generation failed', { data: err }, 'StatementRun');
      setError('Failed to generate statements');
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <AppLayout>
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
            toast.type === 'success'
              ? 'bg-teal-500/90 text-white'
              : 'bg-red-500/90 text-white'
          }`}
        >
          {toast.type === 'success' ? (
            <Mail className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          {toast.message}
        </div>
      )}

      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <FileText className="h-6 w-6 text-purple-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                    Statement Run
                  </h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Batch generate customer statement PDFs
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => sendEmails(selected)}
                  disabled={selected.size === 0 || isSending || isGenerating}
                  title={
                    emailCount < selected.size
                      ? `${selected.size - emailCount} selected have no email`
                      : undefined
                  }
                  className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {isSending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending {emailProgress?.current}/{emailProgress?.total}...
                    </>
                  ) : (
                    <>
                      <SendHorizonal className="h-4 w-4" />
                      Email{selected.size > 0 ? ` (${emailCount}/${selected.size})` : ''}
                    </>
                  )}
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={selected.size === 0 || isGenerating || isSending}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-50 transition-colors"
                >
                  {isGenerating ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
                  ) : (
                    <><Download className="h-4 w-4" /> Generate{selected.size > 0 ? ` (${selected.size})` : ''}</>
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
                name="asAtDate"
                value={asAtDate}
                onChange={e => setAsAtDate(e.target.value)}
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-[var(--ff-text-secondary)]">Min balance:</label>
              <input
                type="number"
                name="minBalance"
                value={minBalance}
                onChange={e => setMinBalance(Number(e.target.value))}
                className="w-32 px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
                step={100}
              />
            </div>
            <button
              onClick={selectAllWithEmail}
              className="text-sm text-teal-400 hover:text-teal-300 underline underline-offset-2"
            >
              Select all with email &amp; balance
            </button>
            <span className="text-sm text-[var(--ff-text-tertiary)]">
              {filtered.length} customer{filtered.length !== 1 ? 's' : ''} &bull; {selected.size} selected
            </span>
          </div>

          {/* Email progress bar */}
          {emailProgress && (
            <div className="p-3 rounded-lg bg-teal-500/10 border border-teal-500/20">
              <div className="flex items-center justify-between text-sm text-teal-400 mb-2">
                <span>
                  Emailing statements {emailProgress.current}/{emailProgress.total}
                  {emailProgress.sent > 0 && ` — ${emailProgress.sent} sent`}
                  {emailProgress.failed > 0 && `, ${emailProgress.failed} failed`}
                </span>
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
              <div className="h-1.5 rounded-full bg-teal-900/40 overflow-hidden">
                <div
                  className="h-full bg-teal-500 rounded-full transition-all duration-300"
                  style={{
                    width: emailProgress.total > 0
                      ? `${(emailProgress.current / emailProgress.total) * 100}%`
                      : '0%',
                  }}
                />
              </div>
            </div>
          )}

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
            <CustomerStatementTable
              customers={filtered}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
