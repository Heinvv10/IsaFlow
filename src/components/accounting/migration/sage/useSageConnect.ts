/**
 * State and API calls for the "Connect to Sage" page.
 *
 * The Sage login lives only in this hook's memory: it is sent to the companies
 * call and to the call that starts the read, and dropped as soon as the read
 * has started, so it is never kept in the browser or stored on the server.
 *
 * The read runs on the server in the background (minutes for a busy company):
 * the hook polls GET /sage-connect/pulls/{pullId} until it is ready or failed,
 * backing off while polls fail (a restart, a dropped connection) and returning
 * to the normal pace on the first good one. On load it asks /status for a read
 * or review already under way, so a refresh resumes where the client was.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, apiErrorMessage, apiFetch, apiJson } from '@/lib/apiFetch';
import type { ApiRouteMap, ResponseFor } from '@/lib/apiRoutes';

export type SageStep = 'loading' | 'unavailable' | 'prior' | 'login' | 'company' | 'reading' | 'review' | 'done';
type Companies = ResponseFor<'/api/accounting/sage-connect/companies'>['companies'];
type PullAnswer = ApiRouteMap['/api/accounting/sage-connect/pulls/{}'];
export type SageReview = NonNullable<PullAnswer['review']>;
type Outcome = ResponseFor<'/api/accounting/sage-connect/import'>;
export type ImportIssue = SageReview['issues'][number];

export const POLL_MS = 3000;
export const MAX_POLL_BACKOFF_MS = 30_000;

/** Said when the import's answer never arrived: it may or may not have gone through. */
export const IMPORT_UNKNOWN = 'IsaFlow did not get an answer from the import, so it may or may not have gone through. Refresh this page to see where it stands before you try again.';

const post = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const ENDED: Record<string, string> = {
  discarded: 'That Sage read was cancelled. Sign in again to start a new one.',
  expired: 'That Sage review was more than 24 hours old and has been cleared. Sign in again to read Sage as it is now.',
  imported: 'That Sage review has been imported.',
};

export function useSageConnect() {
  const [step, setStep] = useState<SageStep>('loading');
  const [busy, setBusy] = useState<null | 'login' | 'pull' | 'import' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importIssues, setImportIssues] = useState<ImportIssue[]>([]);
  const [login, setLogin] = useState<{ email: string; password: string } | null>(null);
  const [companies, setCompanies] = useState<Companies>([]);
  const [pullId, setPullId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [review, setReview] = useState<SageReview | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  /** One poll: moves the page on when the read is done. 'bad' when the poll itself failed. */
  const poll = useCallback(async (id: string): Promise<'pulling' | 'done' | 'bad'> => {
    let data: PullAnswer;
    try {
      data = await apiJson(`/api/accounting/sage-connect/pulls/${id}`, undefined, 'Could not check on the Sage read.');
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) {
        setError('That Sage read was not found. Sign in again to start a new one.');
        setStep('login');
        return 'done';
      }
      setError(apiErrorMessage(err, 'Could not check on the Sage read. Still trying…'));
      return 'bad';
    }
    if (!live.current) return 'done';
    if (data.status === 'pulling') { setError(null); setProgress(data.progress); return 'pulling'; }
    if (data.status === 'ready' && data.review) { setError(null); setReview(data.review); setStep('review'); return 'done'; }
    if (data.status === 'failed') { setError(data.error ?? 'Reading from Sage did not finish.'); setStep('login'); return 'done'; }
    setError(ENDED[data.status] ?? null);
    setStep('login');
    return 'done';
  }, []);

  useEffect(() => {
    if (step !== 'reading' || !pullId) return;
    let stopped = false;
    let wait = POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await poll(pullId);
      if (stopped || r === 'done') return;
      wait = r === 'bad' ? Math.min(wait * 2, MAX_POLL_BACKOFF_MS) : POLL_MS;
      timer = setTimeout(() => { void tick(); }, wait);
    };
    timer = setTimeout(() => { void tick(); }, POLL_MS);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [step, pullId, poll]);

  useEffect(() => {
    apiJson('/api/accounting/sage-connect/status', undefined, 'Could not check whether the Sage connection is available.')
      .then(async (s) => {
        if (!live.current) return;
        if (!s.available) { setStep('unavailable'); return; }
        if (s.priorTakeOn) { setNotice(s.priorTakeOn); setStep('prior'); return; }
        if (s.open) {
          setPullId(s.open.pullId);
          if (s.open.status === 'pulling') { setStep('reading'); return; }
          await poll(s.open.pullId);
          return;
        }
        setStep('login');
      })
      .catch((err: unknown) => {
        if (!live.current) return;
        setError(apiErrorMessage(err, 'Could not check whether the Sage connection is available.'));
        setStep('unavailable');
      });
  }, [poll]);

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

  const startRead = useCallback(async (sageCompanyId: number) => {
    if (!login) { setStep('login'); return; }
    setBusy('pull');
    setError(null);
    try {
      const data = await apiJson('/api/accounting/sage-connect/preview', post({ ...login, sageCompanyId }), 'Could not start reading from Sage.');
      setLogin(null); // the server holds it for the read; the browser no longer needs it
      setPullId(data.pullId);
      setProgress(null);
      setStep('reading');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not start reading from Sage.'));
    } finally {
      setBusy(null);
    }
  }, [login]);

  const runImport = useCallback(async () => {
    if (!pullId) return;
    setBusy('import');
    setError(null);
    setImportIssues([]);
    try {
      const res = await apiFetch('/api/accounting/sage-connect/import', post({ pullId }));
      if (res.ok) {
        const body = (await res.json()) as { data: Outcome };
        setOutcome(body.data);
        setStep('done');
        return;
      }
      // Only a 4xx is the server's own refusal, decided and rolled back: then
      // "nothing was changed" is true. A 5xx — or Cloudflare's 524, which is an
      // HTML page — says nothing about whether the import committed.
      const body = res.status < 500
        ? (await res.json().catch(() => null)) as { error?: { message?: string; details?: { issues?: ImportIssue[] } } } | null
        : null;
      if (body?.error?.message) {
        setError(`${body.error.message} Nothing was changed.`);
        setImportIssues(body.error.details?.issues ?? []);
      } else {
        setError(IMPORT_UNKNOWN);
      }
    } catch {
      setImportIssues([]);
      setOutcome(null);
      setError(IMPORT_UNKNOWN);
    } finally {
      setBusy(null);
    }
  }, [pullId]);

  const startOver = useCallback(async () => {
    setBusy('discard');
    setError(null);
    try {
      if (pullId && (step === 'review' || step === 'reading')) {
        await apiJson('/api/accounting/sage-connect/discard', post({ pullId }), 'Could not discard the Sage review.');
      }
      setPullId(null);
      setReview(null);
      setProgress(null);
      setLogin(null);
      setCompanies([]);
      setImportIssues([]);
      setStep('login');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not discard the Sage review.'));
    } finally {
      setBusy(null);
    }
  }, [pullId, step]);

  return {
    step, busy, error, notice, importIssues, companies, progress, review, outcome,
    connect, startRead, runImport, startOver, backToLogin: () => setStep('login'),
  };
}
