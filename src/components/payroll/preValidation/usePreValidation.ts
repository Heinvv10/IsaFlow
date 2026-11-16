/**
 * Reads GET /api/payroll/pre-validation (wave 6 PV) for one scope: the tax year, one employee or one run. `query`
 * null makes no read. A Login-as session (IMPERSONATION_FORBIDDEN) or a session with no session id (AGENT_FORBIDDEN)
 * is refused by design: `refused` is set and the screens draw nothing, rather than blame the user's role on every
 * profile and approval. Any other 403 reads as the one payroll-detail access message; anything else as `fallback`.
 */
import { useEffect, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage, ApiRequestError } from '@/lib/apiFetch';
import type { ResponseFor } from '@/lib/apiRoutes';
import { payrollLoadMessage } from '@/lib/payrollDetailAccess';

export type PreValidation = ResponseFor<'/api/payroll/pre-validation'>;
export type PreValidationIssue = PreValidation['employees'][number]['issues'][number];

const FALLBACK = 'Could not load the IRP5 pre-validation - try again';
const SILENT_REFUSALS = new Set(['IMPERSONATION_FORBIDDEN', 'AGENT_FORBIDDEN']);

type Body = { data?: unknown; error?: { details?: { reason?: unknown } } };

/** The payload, `'refused'` for a by-design session refusal, or a thrown ApiRequestError for any other failure. */
async function readPreValidation(query: string): Promise<PreValidation | 'refused'> {
  const res = await apiFetch(`/api/payroll/pre-validation?${query}`);
  if (res.status === 403) {
    let refusal: Body | null = null;
    try { refusal = JSON.parse(await res.clone().text()) as Body; } catch { refusal = null; /* non-JSON: assertOk below says so */ }
    if (SILENT_REFUSALS.has(String(refusal?.error?.details?.reason))) return 'refused';
  }
  await assertOk(res, FALLBACK);
  let body: Body | null = null;
  try { body = JSON.parse(await res.text()) as Body; } catch { body = null; /* non-JSON: the shape check below says so */ }
  const d = body?.data as PreValidation | undefined;
  // The payload's shape is checked here, so a wrong body is a failure, not a crash.
  if (!d || !Array.isArray(d.employees) || typeof d.employeesChecked !== 'number') throw new ApiRequestError(FALLBACK, res.status);
  return d;
}

export function usePreValidation(query: string | null): { data: PreValidation | null; error: string; loading: boolean; refused: boolean } {
  const [data, setData] = useState<PreValidation | null>(null);
  const [error, setError] = useState('');
  const [refused, setRefused] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query === null) return undefined;
    let stale = false;
    setLoading(true);
    setError('');
    setRefused(false);
    setData(null);
    readPreValidation(query)
      .then((d) => {
        if (stale) return;
        if (d === 'refused') setRefused(true);
        else setData(d);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setError(err instanceof ApiRequestError ? payrollLoadMessage(err.status, apiErrorMessage(err, FALLBACK)) : FALLBACK);
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [query]);
  return { data, error, loading, refused };
}

export const SEVERITY_TEXT: Record<PreValidationIssue['severity'], string> = {
  error: 'text-red-700 dark:text-red-400',
  warning: 'text-amber-700 dark:text-amber-400',
  info: 'text-[var(--ff-text-secondary)]',
};

export const SEVERITY_LABEL: Record<PreValidationIssue['severity'], string> = { error: 'Must fix', warning: 'Check', info: 'Note' };

/** No `sars_source_codes` row for the year, or none at all: every component code then reads as unknown. */
export function noReleaseNotice(taxYear: number): string {
  return `No SARS source-code release is loaded for tax year ${taxYear}; the code checks for this year are not reliable.`;
}
