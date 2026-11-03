/**
 * useInvoiceAutosave — autosave for the invoice editor (master plan wave 3, PR S, M4), and the unsaved-change guard.
 *
 *   mode 'local'   the new page: the form kept in this browser until create (useLocalInvoiceDraft.ts).
 *   mode 'server'  the edit page: the draft PUT, never create (useServerInvoiceAutosave.ts).
 *
 * While a change is unsaved, or a save is out, leaving asks first, and refusing is never an error:
 *   - closing or reloading the tab: `beforeunload`;
 *   - back and forward with a change that will be kept as the page goes are not asked: the page goes, and the work
 *     is kept as it goes (the edit page PUTs the change being typed, the new page writes its draft; each hook, on
 *     unmount). A change the edit page's autosave is HOLDING (a line or date it refuses, a stale-priced draft, a rate
 *     being typed) would not be sent, so back and forward ask. Leave: it goes without them. Stay: by then the browser
 *     has moved, so this page's own history entry is pushed back (Next has not changed the route). After a one-step
 *     Back, history is as it was; after Forward, or a jump of several entries, the entries past this page are gone
 *     (a browser keeps no forward history past a push);
 *   - a push or replace (a link, a button): `routeChangeStart` throws, Next's only way to cancel one, and the router's
 *     push and replace are wrapped for this page's life so the cancellation resolves false instead of rejecting (no
 *     unhandled rejection: no Sentry event, no dev overlay). The route change a back/forward starts goes through
 *     unasked; if it was a hash change (no route change follows), that pass is dropped.
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

function useLeaveGuard(unsaved: () => boolean, leaveWithout: () => void, heldBack: () => boolean): void {
  const router = useRouter() as NextRouter | null;
  const check = useRef(unsaved);
  const giveUp = useRef(leaveWithout);
  const held = useRef(heldBack);
  useEffect(() => { check.current = unsaved; giveUp.current = leaveWithout; held.current = heldBack; });

  useEffect(() => {
    if (!router) return undefined;
    // A router stub without events (unit tests of other behaviour) gets no route guard; Next's router always has them.
    const events = router.events as NextRouter['events'] | undefined;
    let popping = false; // a back/forward under way: its route change goes through unasked
    // This page's history entry (Next has written it before the page renders), kept to put back when Stay is chosen.
    let here = { state: window.history.state as unknown, url: window.location.href };
    const remember = () => { here = { state: window.history.state as unknown, url: window.location.href }; };

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!check.current()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onHashChange = () => { popping = false; };
    const onRouteChange = () => {
      if (popping) { popping = false; return; }
      if (!check.current()) return;
      if (window.confirm(LEAVE_MESSAGE)) { giveUp.current(); return; } // "Leave without them": nothing is kept as it goes
      events?.emit('routeChangeError');
      throw new NavigationCancelled();
    };
    const restoreNavigation = quietCancellations(router);
    router.beforePopState?.(() => {
      if (check.current() && held.current()) { // autosave would not send it: ask, as a link does
        if (!window.confirm(LEAVE_MESSAGE)) { window.history.pushState(here.state, '', here.url); return false; }
        giveUp.current(); // "Leave without them"
      }
      popping = true;
      return true;
    });
    window.addEventListener('beforeunload', onBeforeUnload);
    events?.on('routeChangeStart', onRouteChange);
    events?.on('hashChangeStart', onHashChange);
    events?.on('routeChangeComplete', remember); // another invoice opened in place
    events?.on('hashChangeComplete', remember);
    return () => {
      events?.off('routeChangeComplete', remember);
      events?.off('hashChangeComplete', remember);
      events?.off('hashChangeStart', onHashChange);
      window.removeEventListener('beforeunload', onBeforeUnload);
      events?.off('routeChangeStart', onRouteChange);
      restoreNavigation();
      router.beforePopState?.(() => true);
    };
  }, [router]);
}

/** The new page's draft is written as the page goes whatever autosave is waiting on (useLocalInvoiceDraft). */
const neverHeld = () => false;

export function useInvoiceAutosave(opts: LocalDraftOptions): LocalDraft;
export function useInvoiceAutosave(opts: ServerAutosaveOptions): ServerAutosave;
export function useInvoiceAutosave(opts: LocalDraftOptions | ServerAutosaveOptions): LocalDraft | ServerAutosave {
  // Both are called every render (hook order); the one for the other mode is idle.
  const local = useLocalInvoiceDraft(opts.mode === 'local' ? opts : null);
  const server = useServerInvoiceAutosave(opts.mode === 'server' ? opts : null);
  const current = opts.mode === 'local' ? local : server;
  useLeaveGuard(current.unsaved, current.leaveWithout, opts.mode === 'server' ? server.heldBack : neverHeld);
  return current;
}
