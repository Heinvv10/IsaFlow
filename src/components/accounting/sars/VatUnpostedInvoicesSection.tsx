/**
 * "Invoices with VAT not posted to the GL" — BLOCKING (reports/vatUnpostedInvoices.ts).
 * An issued invoice or approved bill whose VAT never reached the GL is in
 * neither the filed return nor the control account, so the recon ties at R0
 * without it. Split out of VAT201ExceptionsPanel for the 300-line limit; the
 * panel passes its <Section> shell in.
 *
 * Owner/admin can bulk-select rows here and mark them "VAT declared outside
 * IsaFlow" (vat-declared-elsewhere API) — REPLACES posting to the GL, which
 * is unsafe for an imported document. Never posts a journal.
 */
import { useState, type ReactNode } from 'react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { log } from '@/lib/logger';
import { InlineReasonForm } from '@/components/shared/InlineReasonForm';
import type { UnpostedInvoiceVatLine, VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';

const OVERRIDE_ROLES = ['owner', 'admin', 'super_admin'];
const REASON_LABEL: Record<UnpostedInvoiceVatLine['reason'], string> = {
  no_journal: 'No journal',
  journal_not_posted: 'Journal not posted',
  journal_reversed: 'Journal reversed',
  journal_dated_after_period: 'Journal dated after the VAT period',
};
const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const th = 'px-2 py-1.5 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider';
const td = 'px-2 py-1.5 text-xs text-[var(--ff-text-primary)] whitespace-nowrap';
const tdNum = `${td} text-right tabular-nums`;

type SectionShell = (props: { title: string; count: number; listed: number; children: ReactNode }) => ReactNode;

export default function VatUnpostedInvoicesSection({ report, Section, onChanged }: {
  report: Pick<VatExceptionsReport, 'unpostedInvoiceVat' | 'unpostedInvoiceVatCount' | 'controlRecon'>;
  Section: SectionShell;
  onChanged?: () => void;
}) {
  const { companyRole } = useCompany();
  const isOwnerOrAdmin = OVERRIDE_ROLES.includes(companyRole ?? '');
  const { unpostedCustomerVat, unpostedSupplierVat } = report.controlRecon;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = (kind: string, id: string) => `${kind}:${id}`;
  const toggle = (kind: string, id: string) => {
    const k = key(kind, id);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const markSelected = async (reason: string) => {
    if (selected.size === 0) return;
    setMarking(true);
    setError(null);
    try {
      const byKind = new Map<string, string[]>();
      for (const k of selected) {
        const [kind, id] = k.split(':') as [string, string];
        byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
      }
      for (const [kind, invoiceIds] of byKind) {
        const res = await apiFetch('/api/accounting/vat-declared-elsewhere', {
          method: 'POST',
          body: JSON.stringify({ action: 'mark', kind, invoiceIds, reason }),
        });
        // Any batch failing stops here — the selection is left untouched (not
        // cleared) so the user can see exactly what still needs marking and
        // retry, rather than the UI reporting success on a partial write.
        await assertOk(res, `Could not mark ${kind} document(s) declared elsewhere`);
      }
      setSelected(new Set());
      setConfirming(false);
      onChanged?.();
    } catch (err) {
      log.warn('VatUnpostedInvoicesSection: mark failed', { error: err }, 'VatUnpostedInvoicesSection');
      setError(apiErrorMessage(err, 'Could not mark the selected document(s)'));
    } finally {
      setMarking(false);
    }
  };

  return (
    <Section title="Invoices with VAT not posted to the GL" count={report.unpostedInvoiceVatCount}
      listed={report.unpostedInvoiceVat.length}>
      <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
        Their VAT is in neither the return nor the VAT control account, so filing now would leave it
        out — output VAT {fmt(unpostedCustomerVat)}, input VAT {fmt(unpostedSupplierVat)}. Post them
        (approve / finalise) before filing, or — for an imported historical document only — an
        owner/admin can mark it VAT declared outside IsaFlow below.
      </p>
      {isOwnerOrAdmin && !confirming && (
        <button
          type="button" disabled={selected.size === 0}
          onClick={() => setConfirming(true)}
          className="mb-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
        >
          Mark {selected.size || ''} declared elsewhere
        </button>
      )}
      {isOwnerOrAdmin && confirming && (
        <div className="mb-2">
          <InlineReasonForm
            label={`Mark ${selected.size} document(s) "VAT declared outside IsaFlow" — why?`}
            confirmLabel="Mark"
            busy={marking}
            onConfirm={(reason) => void markSelected(reason)}
            onCancel={() => setConfirming(false)}
          />
        </div>
      )}
      {error && <p className={`${td} !border-0 text-red-400 whitespace-normal`}>{error}</p>}
      <table className="min-w-full">
        <thead><tr>
          {isOwnerOrAdmin && <th className={th}></th>}
          <th className={th}>Invoice</th><th className={th}>Type</th><th className={th}>Counterparty</th>
          <th className={th}>Date</th><th className={th}>Reason</th><th className={`${th} text-right`}>VAT</th>
        </tr></thead>
        <tbody>
          {report.unpostedInvoiceVat.map((u) => (
            <tr key={`${u.invoiceKind}-${u.invoiceId}`}>
              {isOwnerOrAdmin && (
                <td className={td}>
                  <input
                    type="checkbox" checked={selected.has(key(u.invoiceKind, u.invoiceId))}
                    onChange={() => toggle(u.invoiceKind, u.invoiceId)}
                  />
                </td>
              )}
              <td className={td}>{u.invoiceNumber}</td>
              <td className={td}>{u.invoiceKind}</td>
              <td className={td}>{u.counterpartyName}</td>
              <td className={td}>{u.invoiceDate}</td>
              <td className={td}>{REASON_LABEL[u.reason]}</td>
              <td className={tdNum}>{fmt(u.vat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
