/**
 * Live preview of an invoice's PDF, from one of two sources:
 * - `invoiceId` (the edit page): the stored draft, rendered by the same route that prints it. `version` is whatever
 *   the host bumps after a save: a burst of bumps costs one render, and none while the preview is closed.
 * - `unsaved` (the new page, master plan wave 4 PR PV): the body Create would send, rendered by invoice-pdf-preview,
 *   which writes nothing, takes no number and is not metered. A change re-renders it 3 s after the last one, only while
 *   open; it starts closed. While the form cannot be sent (`problem`), or the server refuses it, the last good PDF
 *   stays and the reason is shown.
 *
 * The iframe shows a blob: URL because the API route cannot be framed
 * (X-Frame-Options: DENY); config/securityHeaders.js allows blob: on frame-src
 * for this.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

const REFETCH_DEBOUNCE_MS = 3000;
const LG_QUERY = '(min-width: 1024px)';

type Props =
  | { invoiceId: string; version: number; unsaved?: undefined }
  | { unsaved: { body: unknown } | { problem: string }; invoiceId?: undefined; version?: undefined };

/** The unsaved form's key, where the edit page's is its invoice id. */
const UNSAVED = 'unsaved';

interface Shown { url: string; invoiceId: string; version: number | string }
interface Failure { invoiceId: string; message: string | null }

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

const isPdf = (res: Response): boolean =>
  res.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/pdf';

export function InvoicePdfPreview(props: Props) {
  const { unsaved } = props;
  const invoiceId = unsaved ? UNSAVED : props.invoiceId;
  const body = unsaved && 'body' in unsaved ? JSON.stringify(unsaved.body) : null;
  const problem = unsaved && 'problem' in unsaved ? unsaved.problem : null;
  // An unsaved form's version is its body: any change to what Create would send is a new document.
  const version: number | string = unsaved ? (body ?? '') : props.version;
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  // What the effect below last loaded; state would re-run it.
  const loaded = useRef<{ invoiceId: string; version: number | string } | null>(null);
  const asked = useRef<string | null>(null);
  const wasOpen = useRef(false);
  const panelId = useId();

  // The edit page's opens at lg; the new page's starts closed (each render of an unsaved form is a request).
  useEffect(() => { if (!unsaved) setOpen(window.matchMedia(LG_QUERY).matches); }, [unsaved]);

  // Before the load below: another invoice's PDF goes now, not when its replacement arrives or fails.
  useEffect(() => {
    if (loaded.current?.invoiceId === invoiceId) return;
    loaded.current = null;
    setShown(null);
  }, [invoiceId]);

  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open || problem !== null) return;
    const current = loaded.current;
    if (current?.invoiceId === invoiceId && current.version === version) return;

    // Only an edit under an open preview waits; opening, or another invoice, shows at once.
    const delay = asked.current === invoiceId && !justOpened ? REFETCH_DEBOUNCE_MS : 0;
    asked.current = invoiceId;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = body !== null
            ? await apiFetch('/api/accounting/invoice-pdf-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal, cache: 'no-store' })
            : await apiFetch(`/api/accounting/invoice-pdf?${new URLSearchParams({ invoiceId, disposition: 'inline' })}`, { signal: controller.signal, cache: 'no-store' });
          await assertOk(res, 'Could not load the preview - try again');
          if (!isPdf(res)) throw new Error(`Preview answered ${res.headers.get('Content-Type') ?? 'no content type'}`);
          // The frame's type is ours, never the response's: a blob: URL renders as what it is labelled.
          const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
          if (controller.signal.aborted) return;
          loaded.current = { invoiceId, version };
          setFailure(null);
          setShown({ url: URL.createObjectURL(blob), invoiceId, version });
        } catch (err) {
          if (controller.signal.aborted) return;
          log.warn('Invoice PDF preview failed', { invoiceId, err }, 'InvoicePdfPreview');
          // The unsaved preview says why (the server's sentence: a customer not found, a line refused).
          setFailure({ invoiceId, message: body !== null ? apiErrorMessage(err, 'Could not load the preview - try again') : null });
        }
      })();
    }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, invoiceId, version, body, problem, attempt]);

  useEffect(() => {
    if (!shown) return;
    return () => URL.revokeObjectURL(shown.url);
  }, [shown]);

  function retry() {
    loaded.current = null;
    asked.current = null;
    setFailure(null);
    setAttempt((n) => n + 1);
  }

  // Never another invoice's PDF, however late its replacement arrives.
  const doc = shown?.invoiceId === invoiceId ? shown : null;
  const failed = failure?.invoiceId === invoiceId && problem === null;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <section className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-[var(--ff-text-primary)]">
        <Chevron className="h-4 w-4" aria-hidden="true" />
        <FileText className="h-4 w-4" aria-hidden="true" />
        Preview PDF
      </button>
      {open && (
        <div id={panelId} className="space-y-2 px-4 pb-4">
          {failed && (
            <div role="alert" className="flex items-center gap-3 text-sm text-red-600 dark:text-red-400">
              {failure?.message ? `${failure.message}${doc ? ' What is shown may be out of date.' : ''}`
                : doc ? 'Could not update the preview. What is shown may be out of date.' : 'Could not load the preview.'}
              <button type="button" onClick={retry} aria-label="Retry PDF preview" className="underline">Retry</button>
            </div>
          )}
          <p role="status" className="text-xs text-[var(--ff-text-tertiary)]">
            {problem !== null ? `${sentence(problem)}${doc ? ' What is shown is the last version that could be drawn.' : ''}`
              : failed ? '' : !doc ? 'Loading preview…' : doc.version !== version ? 'Updating preview…' : ''}
          </p>
          {doc && (
            // A new iframe per document (key), never a new src on the same one: an iframe navigating adds a history
            // entry, so each refresh would put one between the editor and Back (and spoil a Back the editor asks about).
            <iframe key={doc.url} title="Invoice PDF preview" src={doc.url}
              className="h-[70vh] w-full rounded border border-[var(--ff-border-light)] bg-white" />
          )}
        </div>
      )}
    </section>
  );
}
