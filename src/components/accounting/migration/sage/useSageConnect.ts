/**
 * State and API calls for the "Connect to Sage" page.
 *
 * The Sage login lives only in this hook's memory: it is sent to the
 * companies and preview calls and dropped as soon as the review is in, so it
 * is never kept in the browser or on the server.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage, apiFetch, apiJson } from '@/lib/apiFetch';
import type { ResponseFor } from '@/lib/apiRoutes';

export type SageStep = 'loading' | 'unavailable' | 'login' | 'company' | 'review' | 'done';
type Companies = ResponseFor<'/api/accounting/sage-connect/companies'>['companies'];
type Preview = ResponseFor<'/api/accounting/sage-connect/preview'>;
type Outcome = ResponseFor<'/api/accounting/sage-connect/import'>;
export type ImportIssue = Preview['review']['issues'][number];

const post = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export function useSageConnect() {
  const [step, setStep] = useState<SageStep>('loading');
  const [busy, setBusy] = useState<null | 'login' | 'pull' | 'import' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);
  const [importIssues, setImportIssues] = useState<ImportIssue[]>([]);
  const [login, setLogin] = useState<{ email: string; password: string } | null>(null);
  const [companies, setCompanies] = useState<Companies>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    let live = true;
    apiJson('/api/accounting/sage-connect/status', undefined, 'Could not check whether the Sage connection is available.')
      .then((s) => { if (live) setStep(s.available ? 'login' : 'unavailable'); })
      .catch((err: unknown) => {
        if (!live) return;
        setError(apiErrorMessage(err, 'Could not check whether the Sage connection is available.'));
        setStep('unavailable');
      });
    return () => { live = false; };
  }, []);

  const connect = useCallback(async (email: string, password: string) => {
    setBusy('login');
    setError(null);
    try {
      const data = await apiJson('/api/accounting/sage-connect/companies', post({ email, password }), 'Could not sign in to Sage.');
      setLogin({ email, password });
      setCompanies(data.companies);
      setStep('company');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not sign in to Sage.'));
    } finally {
      setBusy(null);
    }
  }, []);

  const review = useCallback(async (sageCompanyId: number) => {
    if (!login) { setStep('login'); return; }
    setBusy('pull');
    setError(null);
    try {
      const data = await apiJson('/api/accounting/sage-connect/preview', post({ ...login, sageCompanyId }), 'Could not read your data from Sage.');
      setPreview(data);
      setLogin(null);
      setStep('review');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not read your data from Sage.'));
    } finally {
      setBusy(null);
    }
  }, [login]);

  const runImport = useCallback(async () => {
    if (!preview) return;
    setBusy('import');
    setError(null);
    setImportIssues([]);
    try {
      const res = await apiFetch('/api/accounting/sage-connect/import', post({ pullId: preview.pullId }));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string; details?: { issues?: ImportIssue[] } } } | null;
        setError(body?.error?.message ?? 'The import did not go through. Nothing was changed.');
        setImportIssues(body?.error?.details?.issues ?? []);
        return;
      }
      const body = (await res.json()) as { data: Outcome };
      setOutcome(body.data);
      setStep('done');
    } catch (err) {
      setImportIssues([]);
      setOutcome(null);
      setError(apiErrorMessage(err, 'The import did not go through. Nothing was changed.'));
    } finally {
      setBusy(null);
    }
  }, [preview]);

  const startOver = useCallback(async () => {
    setBusy('discard');
    setError(null);
    try {
      if (preview && step === 'review') {
        await apiJson('/api/accounting/sage-connect/discard', post({ pullId: preview.pullId }), 'Could not discard the Sage review.');
      }
      setPreview(null);
      setLogin(null);
      setCompanies([]);
      setImportIssues([]);
      setStep('login');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not discard the Sage review.'));
    } finally {
      setBusy(null);
    }
  }, [preview, step]);

  return { step, busy, error, importIssues, companies, preview, outcome, connect, review, runImport, startOver, backToLogin: () => setStep('login') };
}
