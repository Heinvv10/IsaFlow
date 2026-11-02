/**
 * useInvoiceAutosave — autosave for the invoice editor (master plan wave 3, PR S, M4), and the unsaved-change guard.
 *
 *   mode 'local'   the new page: the form kept in this browser until create (useLocalInvoiceDraft.ts).
 *   mode 'server'  the edit page: the draft PUT, never create (useServerInvoiceAutosave.ts).
 *
 * While a change is unsaved, or a save is out, leaving asks first: closing or reloading the tab (`beforeunload`) and a
 * Next route change (refusing emits `routeChangeError` and throws, Next's documented way to cancel one). The question
 * is asked of the moment it is needed, so the page's own navigation just after a save goes through unasked.
 */
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { useLocalInvoiceDraft, type LocalDraft, type LocalDraftOptions } from './useLocalInvoiceDraft';
import { useServerInvoiceAutosave, type ServerAutosave, type ServerAutosaveOptions } from './useServerInvoiceAutosave';

export const LEAVE_MESSAGE = 'This invoice has changes that are not saved yet. Leave without them?';

function useLeaveGuard(unsaved: () => boolean): void {
  const router = useRouter();
  // A router stub without events (unit tests of other behaviour) gets no guard; Next's router always has them.
  const events = router.events as typeof router.events | undefined;
  const check = useRef(unsaved);
  useEffect(() => { check.current = unsaved; });

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!check.current()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onRouteChange = () => {
      if (!check.current() || window.confirm(LEAVE_MESSAGE)) return;
      events?.emit('routeChangeError');
      throw new Error('Navigation cancelled: the invoice has unsaved changes.');
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    events?.on('routeChangeStart', onRouteChange);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      events?.off('routeChangeStart', onRouteChange);
    };
  }, [events]);
}

export function useInvoiceAutosave(opts: LocalDraftOptions): LocalDraft;
export function useInvoiceAutosave(opts: ServerAutosaveOptions): ServerAutosave;
export function useInvoiceAutosave(opts: LocalDraftOptions | ServerAutosaveOptions): LocalDraft | ServerAutosave {
  // Both are called every render (hook order); the one for the other mode is idle.
  const local = useLocalInvoiceDraft(opts.mode === 'local' ? opts : null);
  const server = useServerInvoiceAutosave(opts.mode === 'server' ? opts : null);
  const current = opts.mode === 'local' ? local : server;
  useLeaveGuard(current.unsaved);
  return current;
}
