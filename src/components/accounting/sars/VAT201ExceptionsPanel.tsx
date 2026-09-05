/**
 * VAT201 Pre-filing Exceptions panel.
 * Surfaces uncoded GL VAT lines, invoice tax-code issues, invoice↔GL VAT
 * mismatches, and VAT201-box vs GL-control reconciliation for the selected
 * period. Informational only — never blocks generation or submission.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, ShieldAlert } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';
import VatNonSupplySection from './VatNonSupplySection';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Props {
  from: string;
  to: string;
  reloadKey: number;
  /** Surfaces the loaded report (or null while unknown/errored) to the parent
   *  so the eFiling submit gate can read cleanliness. Called from the fetch
   *  effect only, so it never triggers a refetch loop. */
  onLoaded?: (report: VatExceptionsReport | null) => void;
}

function Section({ title, count, listed, children }: {
  title: string; count: number; listed: number; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--ff-border-light)]">
      <button onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-[var(--ff-bg-primary)]/40">
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--ff-text-primary)]">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title}
        </span>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${count > 0 ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
          {count}
        </span>
      </button>
      {open && count > 0 && (
        <div className="px-4 pb-3 overflow-x-auto">
          {children}
          {count > listed && (
            <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">Showing first {listed} of {count}.</p>
          )}
        </div>
      )}
      {open && count === 0 && (
        <p className="px-4 pb-3 text-xs text-[var(--ff-text-tertiary)]">No issues found.</p>
      )}
    </div>
  );
}

const th = 'px-2 py-1.5 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider';
const td = 'px-2 py-1.5 text-xs text-[var(--ff-text-primary)] whitespace-nowrap';
const tdNum = `${td} text-right tabular-nums`;

function VarianceCell({ value }: { value: number }) {
  const off = Math.abs(value) > 0.005;
  return (
    <td className={`${tdNum} font-semibold ${off ? 'text-red-400' : 'text-emerald-400'}`}>
      {fmt(value)}
    </td>
  );
}

export function VAT201ExceptionsPanel({ from, to, reloadKey, onLoaded }: Props) {
  const [report, setReport] = useState<VatExceptionsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    if (!from || !to || reloadKey === 0) return;
    let cancelled = false;
    void (async () => {
      setLoading(true); setError('');
      try {
        const res = await apiFetch(`/api/accounting/sars/vat-exceptions?from=${from}&to=${to}`, { credentials: 'include' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || json.message || 'Failed');
        if (!cancelled) { setReport(json.data); onLoadedRef.current?.(json.data); }
      } catch (err) {
        if (!cancelled) { setReport(null); onLoadedRef.current?.(null); setError(err instanceof Error ? err.message : 'Failed to load exceptions'); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to, reloadKey]);

  if (reloadKey === 0) return null;

  const degraded = report !== null && report.degradedData;
  const clean = report !== null && report.totalExceptions === 0 && !degraded;
  const recon = report?.controlRecon;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {clean
            ? <CheckCircle2 className="h-5 w-5 text-emerald-400" />
            : <ShieldAlert className="h-5 w-5 text-amber-400" />}
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Pre-filing Exceptions</h2>
        </div>
        {loading
          ? <Loader2 className="h-4 w-4 animate-spin text-[var(--ff-text-secondary)]" />
          : report && (
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${clean ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
              {clean ? 'No exceptions' : `${report.totalExceptions} exception${report.totalExceptions === 1 ? '' : 's'}`}
            </span>
          )}
      </div>

      {error && (
        <div className="mx-4 mb-3 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {degraded && (
        <div className="mx-4 mb-3 p-2.5 rounded-lg bg-red-500/10 text-red-400 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          VAT201 source data is incomplete ({report.degradedSources.join(', ')} could not be read) —
          the reconciliation below compares PARTIAL box totals against the GL. Do not file from this run.
        </div>
      )}

      {report && recon && (
        <>
          <div className="px-4 pb-3">
            <p className="text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider mb-2">
              VAT201 vs GL VAT control account
            </p>
            <table className="min-w-[28rem]">
              <thead>
                <tr>
                  <th className={th}></th>
                  <th className={`${th} text-right`}>VAT201</th>
                  <th className={`${th} text-right`}>GL control</th>
                  <th className={`${th} text-right`}>Variance</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={td}>Output VAT</td>
                  <td className={tdNum}>{fmt(recon.outputVat201)}</td>
                  <td className={tdNum}>{fmt(recon.outputGl)}</td>
                  <VarianceCell value={recon.outputVariance} />
                </tr>
                <tr>
                  <td className={td}>Input VAT</td>
                  <td className={tdNum}>{fmt(recon.inputVat201)}</td>
                  <td className={tdNum}>{fmt(recon.inputGl)}</td>
                  <VarianceCell value={recon.inputVariance} />
                </tr>
                <tr className="border-t border-[var(--ff-border-light)]">
                  <td className={`${td} font-semibold`}>Net VAT</td>
                  <td className={`${tdNum} font-semibold`}>{fmt(recon.netVat201)}</td>
                  <td className={`${tdNum} font-semibold`}>{fmt(recon.netGl)}</td>
                  <VarianceCell value={recon.netVariance} />
                </tr>
              </tbody>
            </table>
            {(recon.unpostedCustomerCount > 0 || recon.unpostedSupplierCount > 0) && (
              <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">
                Not yet posted to GL: {recon.unpostedCustomerCount} customer invoice{recon.unpostedCustomerCount === 1 ? '' : 's'} ({fmt(recon.unpostedCustomerVat)} VAT),{' '}
                {recon.unpostedSupplierCount} supplier invoice{recon.unpostedSupplierCount === 1 ? '' : 's'} ({fmt(recon.unpostedSupplierVat)} VAT) — likely source of any variance.
              </p>
            )}
          </div>

          <Section title="Uncoded GL VAT lines (no VAT type)" count={report.uncodedGlLineCount} listed={report.uncodedGlLines.length}>
            <table className="min-w-full">
              <thead><tr>
                <th className={th}>Entry</th><th className={th}>Date</th><th className={th}>Account</th>
                <th className={th}>Description</th><th className={`${th} text-right`}>Amount</th>
              </tr></thead>
              <tbody>
                {report.uncodedGlLines.map((l, i) => (
                  <tr key={`${l.journalEntryId}-${i}`}>
                    <td className={td}>{l.entryNumber}</td>
                    <td className={td}>{l.entryDate}</td>
                    <td className={td}>{l.accountCode} {l.accountName}</td>
                    <td className={`${td} max-w-[16rem] truncate`}>{l.description}</td>
                    <td className={tdNum}>{fmt(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="VAT claimed against a balance-sheet account"
            count={report.vatOnBalanceSheetCount}
            listed={report.vatOnBalanceSheetLines.length}
          >
            <p className={`${td} !border-0 text-slate-500`}>
              VAT belongs to a supply, so the contra leg is normally an income or expense
              account. These lines claim VAT against the balance sheet. Capital goods,
              trading stock, prepayments and the VAT control accounts are excluded — they
              carry VAT legitimately — so anything listed here is worth checking before you
              file.
            </p>
            <table className="min-w-full">
              <thead><tr>
                <th className={th}>Entry</th><th className={th}>Date</th><th className={th}>Account</th>
                <th className={th}>Type</th><th className={th}>VAT type</th>
                <th className={th}>Description</th><th className={`${th} text-right`}>Amount</th>
              </tr></thead>
              <tbody>
                {report.vatOnBalanceSheetLines.map((l, i) => (
                  <tr key={`${l.journalEntryId}-${i}`}>
                    <td className={td}>{l.entryNumber}</td>
                    <td className={td}>{l.entryDate}</td>
                    <td className={td}>{l.accountCode} {l.accountName}</td>
                    <td className={td}>{l.accountSubtype ?? l.accountType}</td>
                    <td className={td}>{l.vatType}</td>
                    <td className={`${td} max-w-[16rem] truncate`}>{l.description}</td>
                    <td className={tdNum}>{fmt(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title="VAT where no supply can arise"
            count={report.vatNonSupplyCount}
            listed={report.vatNonSupplyLines.length}
          >
            <VatNonSupplySection lines={report.vatNonSupplyLines} />
          </Section>

          <Section title="Invoices with tax-code issues" count={report.invoiceTaxCodeIssueCount} listed={report.invoiceTaxCodeIssues.length}>
            <table className="min-w-full">
              <thead><tr>
                <th className={th}>Invoice</th><th className={th}>Type</th><th className={th}>Counterparty</th>
                <th className={th}>Date</th><th className={th}>Issue</th><th className={`${th} text-right`}>Subtotal</th>
              </tr></thead>
              <tbody>
                {report.invoiceTaxCodeIssues.map((inv, i) => (
                  <tr key={`${inv.invoiceId}-${i}`}>
                    <td className={td}>{inv.invoiceNumber}</td>
                    <td className={td}>{inv.invoiceKind}</td>
                    <td className={td}>{inv.counterpartyName}</td>
                    <td className={td}>{inv.invoiceDate}</td>
                    <td className={`${td} text-amber-400`}>
                      {inv.issue === 'missing_tax_rate' ? 'No tax code' : 'Tax code set, zero VAT'}
                    </td>
                    <td className={tdNum}>{fmt(inv.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="Invoice vs GL VAT mismatches" count={report.invoiceGlMismatchCount} listed={report.invoiceGlMismatches.length}>
            <table className="min-w-full">
              <thead><tr>
                <th className={th}>Invoice</th><th className={th}>Type</th><th className={th}>Counterparty</th>
                <th className={`${th} text-right`}>Invoice VAT</th><th className={`${th} text-right`}>GL VAT</th>
                <th className={`${th} text-right`}>Variance</th>
              </tr></thead>
              <tbody>
                {report.invoiceGlMismatches.map((m, i) => (
                  <tr key={`${m.invoiceId}-${i}`}>
                    <td className={td}>{m.invoiceNumber}</td>
                    <td className={td}>{m.invoiceKind}</td>
                    <td className={td}>{m.counterpartyName}</td>
                    <td className={tdNum}>{fmt(m.invoiceVat)}</td>
                    {m.reason === 'je_not_posted' ? (
                      <td className={`${td} text-right text-amber-400 font-semibold`} colSpan={2}>
                        JE not posted
                      </td>
                    ) : (
                      <>
                        <td className={tdNum}>{fmt(m.glVat)}</td>
                        <VarianceCell value={m.variance} />
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </>
      )}
    </div>
  );
}
