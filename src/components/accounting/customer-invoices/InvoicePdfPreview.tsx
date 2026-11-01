/**
 * Live preview of an invoice's PDF, rendered from the stored draft by the same
 * route that prints it. `version` is whatever the host bumps after a save: a
 * burst of bumps costs one render, and none while the preview is closed.
 *
 * The iframe shows a blob: URL because the API route cannot be framed
 * (X-Frame-Options: DENY); config/securityHeaders.js allows blob: on frame-src
 * for this.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

const REFETCH_DEBOUNCE_MS = 3000;
const LG_QUERY = '(min-width: 1024px)';

interface Props {
  invoiceId: string;
  version: number;
}

interface Shown { url: string; invoiceId: string; version: number }

const isPdf = (res: Response): boolean =>
  res.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/pdf';

export function InvoicePdfPreview({ invoiceId, version }: Props) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [failedInvoice, setFailedInvoice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // What the effect below last loaded; state would re-run it.
  const loaded = useRef<{ invoiceId: string; version: number } | null>(null);
  const asked = useRef<string | null>(null);
  const wasOpen = useRef(false);
  const panelId = useId();

  useEffect(() => { setOpen(window.matchMedia(LG_QUERY).matches); }, []);

  // Before the load below: another invoice's PDF goes now, not when its replacement arrives or fails.
  useEffect(() => {
    if (loaded.current?.invoiceId === invoiceId) return;
    loaded.current = null;
    setShown(null);
  }, [invoiceId]);

  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open) return;
    const current = loaded.current;
    if (current?.invoiceId === invoiceId && current.version === version) return;

    // Only an edit under an open preview waits; opening, or another invoice, shows at once.
    const delay = asked.current === invoiceId && !justOpened ? REFETCH_DEBOUNCE_MS : 0;
    asked.current = invoiceId;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ invoiceId, disposition: 'inline' });
          const res = await apiFetch(`/api/accounting/invoice-pdf?${params}`, { signal: controller.signal, cache: 'no-store' });
          await assertOk(res, 'Could not load the preview - try again');
          if (!isPdf(res)) throw new Error(`Preview answered ${res.headers.get('Content-Type') ?? 'no content type'}`);
          // The frame's type is ours, never the response's: a blob: URL renders as what it is labelled.
          const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
          if (controller.signal.aborted) return;
          loaded.current = { invoiceId, version };
          setFailedInvoice(null);
          setShown({ url: URL.createObjectURL(blob), invoiceId, version });
        } catch (err) {
          if (controller.signal.aborted) return;
          log.warn('Invoice PDF preview failed', { invoiceId, err }, 'InvoicePdfPreview');
          setFailedInvoice(invoiceId);
        }
      })();
    }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, invoiceId, version, attempt]);

  useEffect(() => {
    if (!shown) return;
    return () => URL.revokeObjectURL(shown.url);
  }, [shown]);

  function retry() {
    loaded.current = null;
    asked.current = null;
    setFailedInvoice(null);
    setAttempt((n) => n + 1);
  }

  // Never another invoice's PDF, however late its replacement arrives.
  const doc = shown?.invoiceId === invoiceId ? shown : null;
  const failed = failedInvoice === invoiceId;
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
              {doc ? 'Could not update the preview. What is shown may be out of date.' : 'Could not load the preview.'}
              <button type="button" onClick={retry} className="underline">Retry</button>
            </div>
          )}
          <p role="status" className="text-xs text-[var(--ff-text-tertiary)]">
            {failed ? '' : !doc ? 'Loading preview…' : doc.version !== version ? 'Updating preview…' : ''}
          </p>
          {doc && (
            <iframe title="Invoice PDF preview" src={doc.url}
              className="h-[70vh] w-full rounded border border-[var(--ff-border-light)] bg-white" />
          )}
        </div>
      )}
    </section>
  );
}
