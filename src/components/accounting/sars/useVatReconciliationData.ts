/** Loads the VAT reconciliation: the monthly view for a range, or the multi-year summary. */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

interface VatReconMonth {
  month: string;
  glRevenue: number;
  glOutputVat: number;
  glInputVat: number;
  glNetVat: number;
  invoiceRevenue: number;
  returnOutputVat: number | null;
  returnInputVat: number | null;
  returnNetVat: number | null;
  returnStatus: string | null;
  capitalGoodsOutput: number;
  capitalGoodsInput: number;
  otherGoodsOutput: number;
  otherGoodsInput: number;
  revenueVariance: number;
  outputVatVariance: number;
  inputVatVariance: number;
  effectiveVatRate: number;
}

export interface VatReconData {
  type: 'reconciliation';
  months: VatReconMonth[];
  totals: {
    glRevenue: number;
    glOutputVat: number;
    glInputVat: number;
    glNetVat: number;
    invoiceRevenue: number;
    returnNetVat: number;
    capitalGoodsOutput: number;
    capitalGoodsInput: number;
    revenueVariance: number;
    outputVatVariance: number;
    inputVatVariance: number;
  };
  issues: Array<{ month: string; severity: string; message: string }>;
}

interface VatYearSummary {
  year: number;
  totalOutputVat: number;
  totalInputVat: number;
  netVat: number;
  totalRevenue: number;
  effectiveRate: number;
  returnsSubmitted: number;
  returnsExpected: number;
}

export interface MultiYearData {
  type: 'multi_year';
  summary: VatYearSummary[];
}

export type ViewMode = 'reconciliation' | 'multi_year';

export function useVatReconciliationData(mode: ViewMode, from: string, to: string) {
  const [reconData, setReconData] = useState<VatReconData | null>(null);
  const [multiData, setMultiData] = useState<MultiYearData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const url = mode === 'multi_year'
        ? '/api/accounting/vat-reconciliation?multi_year=3'
        : `/api/accounting/vat-reconciliation?from=${from}&to=${to}`;
      const res = await apiFetch(url); await assertOk(res, 'Could not load the VAT reconciliation - try again');
      const json = await res.json();
      if (mode === 'multi_year') {
        setMultiData(json.data);
      } else {
        setReconData(json.data);
      }
    } catch (err: unknown) {
      setReconData(null); setMultiData(null); setError(apiErrorMessage(err, 'Could not load the VAT reconciliation - try again'));
    } finally {
      setLoading(false);
    }
  }, [mode, from, to]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  return { reconData, multiData, loading, error };
}
