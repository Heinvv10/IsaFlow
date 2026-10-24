/**
 * "VAT declared outside IsaFlow" — NON-blocking (reports/vatUnpostedInvoices
 * .findVatDeclaredElsewhere). Same population as VatUnpostedInvoicesSection,
 * marked by an owner/admin so it no longer blocks; kept visible here rather
 * than hidden. Unmark (owner/admin, with a reason) restores the block.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { log } from '@/lib/logger';
import { InlineReasonForm } from '@/components/shared/InlineReasonForm';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

const OVERRIDE_ROLES = ['owner', 'admin', 'super_admin'];
const fmt = (n: number) => formatMoney(n);
const th = 'px-2 py-1.5 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider';
const td = 'px-2 py-1.5 text-xs text-[var(--ff-text-primary)] whitespace-nowrap';

export default function VatDeclaredElsewhereSection({ report, onChanged }: {
  report: Pick<VatExceptionsReport, 'declaredElsewhereVat' | 'declaredElsewhereVatCount'>;
  onChanged: () => void;
}) {
  const { companyRole } = useCompany();
  const isOwnerOrAdmin = OVERRIDE_ROLES.includes(companyRole ?? '');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unmarking, setUnmarking] = useState<{ id: string; kind: 'customer' | 'supplier'; number: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (report.declaredElsewhereVatCount === 0) return null;

  const unmark = async (invoiceId: string, kind: 'customer' | 'supplier', reason: string) => {
    setBusyId(invoiceId);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/vat-declared-elsewhere', {
        method: 'POST',
        body: JSON.stringify({ action: 'unmark', kind, invoiceIds: [invoiceId], reason }),
      });
      await assertOk(res, 'Could not unmark this document');
      setUnmarking(null);
      onChanged();
    } catch (err) {
      log.warn('VatDeclaredElsewhereSection: unmark failed', { error: err }, 'VatDeclaredElsewhereSection');
      setError(apiErrorMessage(err, 'Could not unmark this document'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="border-t border-[var(--ff-border-light)] px-4 py-3">
      <p className="text-sm font-medium text-[var(--ff-text-primary)]">
        VAT declared outside IsaFlow ({report.declaredElsewhereVatCount})
      </p>
      <p className={`${td} !border-0 text-slate-500 whitespace-normal`}>
        Not blocking filing — marked by an owner/admin as historical/already declared.
      </p>
      {error && <p className={`${td} !border-0 text-red-400 whitespace-normal`}>{error}</p>}
      {unmarking && (
        <div className="mt-2">
          <InlineReasonForm
            key={unmarking.id}
            label={`Why is ${unmarking.number} being unmarked (restoring the block)?`}
            confirmLabel="Confirm unmark"
            busy={busyId === unmarking.id}
            onConfirm={(reason) => void unmark(unmarking.id, unmarking.kind, reason)}
            onCancel={() => setUnmarking(null)}
          />
        </div>
      )}
      <table className="min-w-full mt-2">
        <thead><tr>
          <th className={th}>Invoice</th><th className={th}>Type</th><th className={th}>Counterparty</th>
          <th className={th}>Date</th><th className={`${th} text-right`}>VAT</th>
          <th className={th}>Marked by</th><th className={th}>Reason</th>
          {isOwnerOrAdmin && <th className={th}></th>}
        </tr></thead>
        <tbody>
          {report.declaredElsewhereVat.map((d) => (
            <tr key={`${d.invoiceKind}-${d.invoiceId}`}>
              <td className={td}>{d.invoiceNumber}</td>
              <td className={td}>{d.invoiceKind}</td>
              <td className={td}>{d.counterpartyName}</td>
              <td className={td}>{formatDisplayDate(d.invoiceDate, '')}</td>
              <td className={`${td} text-right tabular-nums`}>{fmt(d.vat)}</td>
              <td className={td}>{d.markedByName}</td>
              <td className={`${td} max-w-[16rem] truncate`}>{d.markedReason}</td>
              {isOwnerOrAdmin && (
                <td className={td}>
                  <button
                    type="button" disabled={busyId !== null}
                    onClick={() => setUnmarking({ id: d.invoiceId, kind: d.invoiceKind, number: d.invoiceNumber })}
                    className="text-xs text-red-400 underline disabled:opacity-50"
                  >
                    {busyId === d.invoiceId ? <Loader2 className="h-3 w-3 animate-spin inline" /> : 'Unmark'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
