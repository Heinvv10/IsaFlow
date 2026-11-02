/**
 * Server autosave for a draft invoice on the edit page (master plan wave 3, PR S): the Save button's body, PUT to
 * customer-invoices-detail 1.5 s after the last change. Never create: that route is wallet-metered (spec rule 10).
 *
 * - Only when the body differs from what the server last took (the body the page loaded with, then each one saved). An
 *   edit PUT stamps the editor as an approval author (R-035 PR4), so loading the page, or typing a value back, sends nothing.
 * - Never while `paused` (a VAT rate edit under way: in inclusive mode each keystroke reprices the net) or while
 *   `problem` holds (autosaveProblem: a half-typed line, a refused date, no client, no priced line).
 * - One PUT at a time. A change made while one is out goes next, as the newest body then. A reply is applied only if it
 *   answers the newest request (sequence number), and it marks saved only the body it carried, never a newer one.
 * - A refusal stops autosave and shows the server's sentence; the next change re-arms it. Nothing is retried by itself.
 *
 * The body is one render's snapshot, kept whole in one ref: never lines from one render and the mode from another.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { AutosaveState } from '@/components/ui/AutosaveStatus';
import type { InvoicePutBody } from './invoicePutBody';

export const SERVER_DEBOUNCE_MS = 1500;
/**
 * Syncs what a click reads in the commit itself: a passive effect can run after the page is on screen, and a Save
 * clicked in between would find the ref still empty. (useEffect on the server, where there is no layout.)
 */
export const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const SAVE_FAILED = 'Could not save the invoice - try again';

export interface ServerAutosaveOptions {
  mode: 'server';
  invoiceId: string;
  /** The Save button's body this render; null until the invoice has loaded. */
  body: InvoicePutBody | null;
  /** autosaveProblem's answer this render: why the body is held back, or null. */
  problem: string | null;
  /** A VAT rate edit is under way. */
  paused: boolean;
  /** The invoice is no longer a draft (approved here): nothing more is saved. */
  done?: boolean;
  /** The body the server just took (JSON). */
  onSaved?: (json: string) => void;
}

export type SaveResult = { ok: true } | { ok: false; message: string };

export interface ServerAutosave {
  /** What to show; null when there is nothing to say yet (nothing changed on this visit). */
  state: AutosaveState | null;
  savedAt: number | null;
  error: string | null;
  /** Bumped by each save the server took: the PDF preview's version. */
  savedCount: number;
  /**
   * Save the newest body now (Approve & email: only if it differs from the server's; `always`, the Save button, as it
   * always has). Waits out an autosave first, so two PUTs are never out at once.
   */
  saveNow: (always?: boolean) => Promise<SaveResult>;
  /** Read at the moment of asking: a change not yet saved, or a save out. */
  unsaved: () => boolean;
  /** Why a change on screen is not being saved (the body `problem`), while there is one; null otherwise. */
  held: string | null;
  /** The newest body as sent, at the moment of asking (Approve & email compares it before and after). */
  currentBody: () => string | null;
}

interface Failure { json: string; message: string }
type Send = 'auto' | 'changed' | 'always';

export function useServerInvoiceAutosave(opts: ServerAutosaveOptions | null): ServerAutosave {
  const json = opts?.body ? JSON.stringify(opts.body) : null;
  const latest = useRef<{ json: string | null; armed: boolean; done: boolean }>({ json: null, armed: false, done: false });
  const lastSaved = useRef<string | null>(null);
  const [savedJson, setSavedJson] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const inFlight = useRef<Promise<SaveResult> | null>(null);
  const again = useRef(false);
  const seq = useRef(0);

  const onSaved = useRef(opts?.onSaved);
  useCommitEffect(() => { onSaved.current = opts?.onSaved; });
  const failed = failure !== null && failure.json === json ? failure : null;
  const armed = Boolean(opts && json !== null && !opts.done && !opts.paused && !opts.problem && !failed);

  // First: what the timers and the guard read. Then the body the page loaded with is what the server holds.
  useCommitEffect(() => { latest.current = { json, armed, done: Boolean(opts?.done) }; });
  // Another invoice opened in place: nothing it shows has been saved by this page yet, and a reply for the old one is stale.
  const invoiceId = opts?.invoiceId ?? null;
  const shownFor = useRef(invoiceId);
  useCommitEffect(() => {
    if (shownFor.current === invoiceId) return;
    shownFor.current = invoiceId;
    seq.current++;
    lastSaved.current = null;
    setSavedJson(null);
    setSavedAt(null);
    setFailure(null);
    setSaving(false);
  }, [invoiceId]);
  useCommitEffect(() => {
    if (json === null || lastSaved.current !== null) return;
    lastSaved.current = json;
    setSavedJson(json);
  }, [json]);
  // Unmounted (Back, Forward, a link): a change still waiting for its 1.5 s goes now, after any PUT still out, so the
  // older body never lands last. Its reply has no page to update: every reply still out is stale from here.
  useEffect(() => () => {
    seq.current++;
    const { json: last, armed: sendable } = latest.current;
    if (!sendable || last === null || last === lastSaved.current) return;
    const prior = inFlight.current;
    void (async () => {
      try {
        if (prior) await prior;
        const res = await apiFetch('/api/accounting/customer-invoices-detail', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: last });
        await assertOk(res, SAVE_FAILED);
      } catch (err) {
        log.warn('The change typed as the invoice page closed was not saved', { err }, 'useServerInvoiceAutosave');
      }
    })();
  }, []);

  // 'auto': the timer's, only while armed; 'changed': a button's, if the body moved; 'always': the Save button's.
  const send = useCallback(async (how: Send): Promise<SaveResult> => {
    const sent = latest.current.json;
    if (sent === null) return { ok: false, message: 'The invoice has not loaded yet' };
    if (latest.current.done || (how !== 'always' && sent === lastSaved.current) || (how === 'auto' && !latest.current.armed)) return { ok: true };
    const mine = ++seq.current;
    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-detail', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: sent });
      await assertOk(res, SAVE_FAILED);
      if (mine !== seq.current) return { ok: true };
      lastSaved.current = sent; // what this reply carried, never the newer body typed while it was out
      setSavedJson(sent);
      setSavedAt(Date.now());
      setSavedCount((n) => n + 1);
      setFailure(null);
      onSaved.current?.(sent);
      return { ok: true };
    } catch (err) {
      const message = apiErrorMessage(err, SAVE_FAILED);
      if (mine === seq.current) setFailure({ json: sent, message });
      return { ok: false, message };
    } finally {
      if (mine === seq.current) setSaving(false);
    }
  }, []);

  const flush = useCallback(async (how: Send): Promise<SaveResult> => {
    while (inFlight.current) {
      if (how === 'auto') { again.current = true; return inFlight.current; }
      await inFlight.current;
    }
    const run = (async () => {
      const first = await send(how);
      while (again.current) { again.current = false; await send('auto'); }
      return first;
    })();
    inFlight.current = run;
    try { return await run; } finally { inFlight.current = null; }
  }, [send]);

  useEffect(() => {
    if (!armed || json === lastSaved.current) return undefined;
    const timer = setTimeout(() => { void flush('auto'); }, SERVER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [armed, json, flush]);

  const saveNow = useCallback((always = false) => flush(always ? 'always' : 'changed'), [flush]);
  const unsaved = useCallback(() => !latest.current.done && (inFlight.current !== null
    || (lastSaved.current !== null && latest.current.json !== lastSaved.current)), []);

  const currentBody = useCallback(() => latest.current.json, []);
  const state: AutosaveState | null = !opts || json === null ? null
    : failed ? 'error'
      : saving ? 'saving'
        : savedJson !== null && json !== savedJson ? 'dirty'
          : savedAt !== null ? 'saved' : null;
  const held = state === 'dirty' && opts?.problem && !opts.paused ? opts.problem : null;
  return { state, savedAt, error: failed?.message ?? null, savedCount, saveNow, unsaved, held, currentBody };
}
