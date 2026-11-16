/**
 * Reads GET /api/payroll/pre-validation (wave 6 PV) for one scope: the tax year, one employee or one run. `query`
 * null makes no read. A 403 reads as the one payroll-detail access message; any other failure as `fallback`.
 */
import { useEffect, useState } from 'react';
import { apiJson, apiErrorMessage, ApiRequestError } from '@/lib/apiFetch';
import type { ResponseFor } from '@/lib/apiRoutes';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';

export type PreValidation = ResponseFor<'/api/payroll/pre-validation'>;
export type PreValidationIssue = PreValidation['employees'][number]['issues'][number];

const FALLBACK = 'Could not load the IRP5 pre-validation - try again';

export function usePreValidation(query: string | null): { data: PreValidation | null; error: string; loading: boolean } {
  const [data, setData] = useState<PreValidation | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query === null) return undefined;
    let stale = false;
    setLoading(true);
    setError('');
    setData(null);
    apiJson(`/api/payroll/pre-validation?${query}`, undefined, FALLBACK)
      .then((d) => {
        if (stale) return;
        // The envelope is checked by apiJson; the payload's shape is checked here, so a wrong body is a failure, not a crash.
        if (!d || !Array.isArray(d.employees) || typeof d.employeesChecked !== 'number') setError(FALLBACK);
        else setData(d);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setError(err instanceof ApiRequestError ? payrollLoadMessage(err.status, apiErrorMessage(err, FALLBACK)) : FALLBACK);
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [query]);
  return { data, error, loading };
}

export const SEVERITY_TEXT: Record<PreValidationIssue['severity'], string> = {
  error: 'text-red-700 dark:text-red-400',
  warning: 'text-amber-700 dark:text-amber-400',
  info: 'text-[var(--ff-text-secondary)]',
};

export const SEVERITY_LABEL: Record<PreValidationIssue['severity'], string> = { error: 'Error', warning: 'Warning', info: 'Note' };

/** No `sars_source_codes` row for the year, or none at all: every component code then reads as unknown. */
export function noReleaseNotice(taxYear: number): string {
  return `No SARS source-code release is loaded for tax year ${taxYear}; the code checks for this year are not reliable.`;
}
