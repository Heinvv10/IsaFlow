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
 *     being typed, a removed time-entry line) would not be sent, so back and forward ask. Leave: it goes without them.
 *     Stay: by then the browser has moved and Next has not changed the route, so the move is undone with the
 *     Navigation API: `navigation.traverseTo(key)` back to this page's own entry. Firefox and Safari fall back to
 *     `history.go(delta)`, using the indexes carried by Next's history entries. Back, Forward or a jump of several
 *     entries keeps history's order (nothing is pushed). If neither an entry key nor indexes are known, the move
 *     cannot be undone exactly, and it is not asked: the page goes, as it did;
 *   - a push or replace (a link, a button): `routeChangeStart` throws, Next's only way to cancel one, and the router's
 *     push and replace are wrapped for this page's life so the cancellation resolves false instead of rejecting (no
 *     unhandled rejection: no Sentry event, no dev overlay). The route change a back/forward starts goes through
 *     unasked; if it was a hash change (no route change follows), that pass is dropped.
 * The question is asked of the moment it is needed, so the page's own navigation just after a save goes through unasked.
 * With a PUT still out it says so: that save finishes whatever the answer (useServerInvoiceAutosave's leaveWithout).
 */
import { useEffect, useRef } from 'react';
import { useRouter, type NextRouter } from 'next/router';
import { log } from '@/lib/logger';
import { historyIndexOf } from '@/lib/historyIndex';
import { useLocalInvoiceDraft, type LocalDraft, type LocalDraftOptions } from './useLocalInvoiceDraft';
import { useServerInvoiceAutosave, type ServerAutosave, type ServerAutosaveOptions } from './useServerInvoiceAutosave';

export const LEAVE_MESSAGE = 'This invoice has changes that are not saved yet. Leave without them?';
const SAVE_FINISHING = 'A save is still finishing: it will complete either way.';

/** The Navigation API, where the browser has it (Chromium; not every browser yet). */
interface NavigationLike {
  currentEntry?: { key: string } | null;
  traverseTo?: (key: string) => { committed?: Promise<unknown>; finished?: Promise<unknown> };
}
const navigationApi = (): NavigationLike | null =>
  (typeof window !== 'undefined' && (window as unknown as { navigation?: NavigationLike }).navigation) || null;
const entryKey = (): string | null => navigationApi()?.currentEntry?.key ?? null;

interface Guarded {
  unsaved: () => boolean;
  leaveWithout: () => void;
  /** A change autosave is holding back: leaving by back/forward would lose it. */
  heldBack: () => boolean;
  /** A save is out now. */
  saveOut: () => boolean;
}

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

function useLeaveGuard(guarded: Guarded): void {
  const router = useRouter() as NextRouter | null;
  const g = useRef(guarded);
  useEffect(() => { g.current = guarded; });

  useEffect(() => {
    if (!router) return undefined;
    // A router stub without events (unit tests of other behaviour) gets no route guard; Next's router always has them.
    const events = router.events as NextRouter['events'] | undefined;
    let popping = false; // a back/forward under way: its route change goes through unasked
    let here = entryKey(); // this page's own history entry (Navigation API key)
    let hereIndex = historyIndexOf(window.history.state);
    const remember = () => { here = entryKey(); hereIndex = historyIndexOf(window.history.state); };
    let restoring = false; // Stay's traverseTo is under way, back to `here`
    let restoringIndex: number | null = null; // Stay's history.go fallback is returning to this index
    const question = () => (g.current.saveOut() ? `${LEAVE_MESSAGE} ${SAVE_FINISHING}` : LEAVE_MESSAGE);

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!g.current.unsaved()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const onHashChange = () => { popping = false; };
    const onRouteChange = () => {
      if (popping) { popping = false; return; }
      if (!g.current.unsaved()) return;
      if (window.confirm(question())) { g.current.leaveWithout(); return; } // "Leave without them": nothing kept as it goes
      events?.emit('routeChangeError');
      throw new NavigationCancelled();
    };
    const restoreNavigation = quietCancellations(router);
    router.beforePopState?.((state) => {
      const now = entryKey(); // the entry the browser moved to
      const toIndex = historyIndexOf(state);
      if (restoring) {
        restoring = false;
        if (now !== null && now === here) return false; // Stay's own move, home again: nothing to route
      }
      if (restoringIndex !== null) {
        const restored = toIndex === restoringIndex;
        restoringIndex = null;
        if (restored) return false;
      }
      // Autosave would not send it: ask, as a link does. Only when the move can be undone exactly.
      const nav = navigationApi();
      const canTraverse = here !== null && now !== null && now !== here && typeof nav?.traverseTo === 'function';
      const historyDelta = hereIndex !== null && toIndex !== null && toIndex !== hereIndex ? hereIndex - toIndex : null;
      if ((canTraverse || historyDelta !== null) && g.current.unsaved() && g.current.heldBack()) {
        if (!window.confirm(question())) {
          if (canTraverse) {
            restoring = true;
            const undo = nav!.traverseTo!(here!); // back to this page's own entry: history keeps its order
            const failed = (err: unknown) => { restoring = false; log.warn('Could not return to the invoice after Stay', { err }, 'useInvoiceAutosave'); };
            undo.committed?.catch(failed);
            undo.finished?.catch(failed);
          } else {
            restoringIndex = hereIndex;
            window.history.go(historyDelta!);
          }
          return false; // Next has not changed the route
        }
        g.current.leaveWithout(); // "Leave without them"
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

/** The new page's draft is written as the page goes whatever autosave is waiting on (useLocalInvoiceDraft); no PUTs. */
const never = () => false;

export function useInvoiceAutosave(opts: LocalDraftOptions): LocalDraft;
export function useInvoiceAutosave(opts: ServerAutosaveOptions): ServerAutosave;
export function useInvoiceAutosave(opts: LocalDraftOptions | ServerAutosaveOptions): LocalDraft | ServerAutosave {
  // Both are called every render (hook order); the one for the other mode is idle.
  const local = useLocalInvoiceDraft(opts.mode === 'local' ? opts : null);
  const server = useServerInvoiceAutosave(opts.mode === 'server' ? opts : null);
  const current = opts.mode === 'local' ? local : server;
  useLeaveGuard(opts.mode === 'server'
    ? { unsaved: server.unsaved, leaveWithout: server.leaveWithout, heldBack: server.heldBack, saveOut: server.saveOut }
    : { unsaved: local.unsaved, leaveWithout: local.leaveWithout, heldBack: never, saveOut: never });
  return current;
}
