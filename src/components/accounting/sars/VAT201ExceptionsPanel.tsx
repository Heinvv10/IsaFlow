/** VAT201 pre-filing exceptions for the selected period (reports/vatExceptionsService):
 *  recon, uncoded lines, unposted and invoice issues, input-VAT support. The counted ones gate ISV eFiling. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';
import VatNonSupplySection from './VatNonSupplySection';
import VatInputSupportSections from './VatInputSupportSections';
import VatUnpostedInvoicesSection from './VatUnpostedInvoicesSection';
import VatDeclaredElsewhereSection from './VatDeclaredElsewhereSection';
import { Section } from './vatExceptionsUi';
import {
  VatReconTable, VatUncodedAndBalanceSheetSections, VatInvoiceIssueSections, VatBillTaxCodeWarningSection,
} from './VatReconAndBasicSections';

interface Props {
  from: string;
  to: string;
  reloadKey: number;
  /** Surfaces the loaded report (or null while unknown/errored) to the parent
   *  so the eFiling submit gate can read cleanliness. Called from the fetch
   *  effect only, so it never triggers a refetch loop. */
  onLoaded?: (report: VatExceptionsReport | null) => void;
}

export function VAT201ExceptionsPanel({ from, to, reloadKey, onLoaded }: Props) {
  const [report, setReport] = useState<VatExceptionsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async (cancelledRef?: { current: boolean }) => {
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/accounting/sars/vat-exceptions?from=${from}&to=${to}`, { credentials: 'include' });
      await assertOk(res, 'Could not load exceptions - try again');
      const json = await res.json();
      if (!cancelledRef?.current) { setReport(json.data); onLoadedRef.current?.(json.data); }
    } catch (err) {
      if (!cancelledRef?.current) {
        setReport(null); onLoadedRef.current?.(null);
        setError(apiErrorMessage(err, 'Could not load exceptions - try again'));
      }
    } finally {
      if (!cancelledRef?.current) setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (!from || !to || reloadKey === 0) return;
    const cancelledRef = { current: false };
    void load(cancelledRef);
    return () => { cancelledRef.current = true; };
  }, [from, to, reloadKey, load]);

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
          <VatReconTable recon={recon} />
          <VatUncodedAndBalanceSheetSections report={report} />

          <Section
            title="VAT where no supply can arise"
            count={report.vatNonSupplyCount}
            listed={report.vatNonSupplyLines.length}
          >
            <VatNonSupplySection lines={report.vatNonSupplyLines} />
          </Section>

          <VatUnpostedInvoicesSection report={report} Section={Section} onChanged={() => void load()} />
          <VatDeclaredElsewhereSection report={report} onChanged={() => void load()} />
          <VatInputSupportSections report={report} Section={Section} />
          <VatInvoiceIssueSections report={report} />
          <VatBillTaxCodeWarningSection report={report} />
        </>
      )}
    </div>
  );
}
