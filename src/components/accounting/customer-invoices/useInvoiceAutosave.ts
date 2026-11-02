/**
 * useInvoiceAutosave — autosave for the invoice editor (master plan wave 3, PR S, M4), and the unsaved-change guard.
 *
 *   mode 'local'   the new page: the form kept in this browser until create (useLocalInvoiceDraft.ts).
 *   mode 'server'  the edit page: the draft PUT, never create (useServerInvoiceAutosave.ts).
 *
 * While a change is unsaved, or a save is out, leaving asks first, and refusing is never an error:
 *   - closing or reloading the tab: `beforeunload`;
 *   - back and forward: `beforePopState`, whose false keeps the page; the URL the browser already moved is put back
 *     with replaceState (no new history entry; the entry it moved to now holds this page);
 *   - a push or replace (a link, a button): `routeChangeStart` throws, Next's only way to cancel one, and the router's
 *     push and replace are wrapped for this page's life so the cancellation resolves false instead of rejecting (no
 *     unhandled rejection: no Sentry event, no dev overlay). A leave confirmed on back/forward is not asked again; if
 *     it was a hash change (no route change follows), the pass is dropped.
 * The question is asked of the moment it is needed, so the page's own navigation just after a save goes through unasked.
 */
import { useEffect, useRef } from 'react';
import { useRouter, type NextRouter } from 'next/router';
import { useLocalInvoiceDraft, type LocalDraft, type LocalDraftOptions } from './useLocalInvoiceDraft';
import { useServerInvoiceAutosave, type ServerAutosave, type ServerAutosaveOptions } from './useServerInvoiceAutosave';

export const LEAVE_MESSAGE = 'This invoice has changes that are not saved yet. Leave without them?';

class NavigationCancelled extends Error {
  readonly cancelled = true;
  constructor() { super('Navigation cancelled: the invoice has unsaved changes.'); }
}

type Navigate = NextRouter['push'];

/** Wraps the router's push and replace so a cancelled navigation resolves false; returns the undo. */
function quietCancellations(router: NextRouter): () => void {
  const { push, replace } = router;
  const quiet = (go: Navigate): Navigate => async (...args) => {
    try {
      return await go.apply(router, args);
    } catch (err) {
      if (err instanceof NavigationCancelled) return false;
      throw err;
    }
  };
  router.push = quiet(push);
  router.replace = quiet(replace);
  return () => { router.push = push; router.replace = replace; };
}

function useLeaveGuard(unsaved: () => boolean): void {
  const router = useRouter() as NextRouter | null;
  const check = useRef(unsaved);
  useEffect(() => { check.current = unsaved; });

  useEffect(() => {
    if (!router) return undefined;
    // A router stub without events (unit tests of other behaviour) gets no route guard; Next's router always has them.
    const events = router.events as NextRouter['events'] | undefined;
    let confirmed = false; // a back/forward the user agreed to: its route change goes through unasked
    // This page's history entry, to put the URL back when a back/forward is refused (the browser has already moved).
    const entry = { state: window.history.state as unknown, url: window.location.href };
    const ask = () => !check.current() || window.confirm(LEAVE_MESSAGE);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!check.current()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onHashChange = () => { confirmed = false; };
    const onRouteChange = () => {
      if (confirmed) { confirmed = false; return; }
      if (ask()) return;
      events?.emit('routeChangeError');
      throw new NavigationCancelled();
    };
    const restoreNavigation = quietCancellations(router);
    router.beforePopState?.(() => {
      if (!check.current()) return true;
      if (window.confirm(LEAVE_MESSAGE)) { confirmed = true; return true; }
      window.history.replaceState(entry.state, '', entry.url);
      return false;
    });
    window.addEventListener('beforeunload', onBeforeUnload);
    events?.on('routeChangeStart', onRouteChange);
    events?.on('hashChangeStart', onHashChange);
    return () => {
      events?.off('hashChangeStart', onHashChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      events?.off('routeChangeStart', onRouteChange);
      restoreNavigation();
      router.beforePopState?.(() => true);
    };
  }, [router]);
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
