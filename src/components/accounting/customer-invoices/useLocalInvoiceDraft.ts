/**
 * A new invoice's form, kept in this browser until it is created (master plan wave 3, PR S; spec decision 1: no server
 * draft, so no wallet charge and no burnt invoice number). 800 ms after the last change the form, lines and VAT mode,
 * taken together from one render, go to localStorage under the company and user (src/lib/invoiceDrafts.ts).
 *
 * - Nothing is written until the form differs from how the page opened, and nothing without a company and a user.
 * - A kept draft is offered on the next visit; nothing overwrites it until the user restores or discards it. An invoice
 *   created meanwhile leaves it kept and still offered (after Save & New too), and this page writes nothing over it
 *   until the user answers; the page says so beside the offer.
 * - A clear (sign-out, a company switch) ends this page's writing: a timer still pending writes nothing back. A clear
 *   in ANOTHER tab says so on this page ("no longer kept"), and leaving still asks: what is on screen is the only copy.
 * - Left before the 800 ms are up (Back, a link), the page writes what was typed as it goes.
 * - Never while `paused` (a VAT rate edit under way), as on the edit page.
 * - A storage that throws is shown, never raised; the next change tries again.
 * - `clear` after a successful create; sign-out and a company switch clear every draft (AuthContext, CompanyContext).
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '@/contexts/AuthContext';
import { CompanyContext } from '@/contexts/CompanyContext';
import type { AutosaveState } from '@/components/ui/AutosaveStatus';
import { INVOICE_DRAFT_GENERATION_KEY, invoiceDraftGeneration, invoiceDraftsClearedSince, invoiceDraftKey, readInvoiceDraft, removeInvoiceDraft, writeInvoiceDraft, type StoredDraft } from '@/lib/invoiceDrafts';
import type { InvoiceHeaderForm } from './invoiceHeaderForm';
import type { InvoiceLine } from './InvoiceLineItemsTable';
import type { TaxMode } from './taxMode';
import { useCommitEffect } from './useServerInvoiceAutosave';

export const LOCAL_DEBOUNCE_MS = 800;

export interface LocalDraftData { form: InvoiceHeaderForm; lines: InvoiceLine[]; taxMode: TaxMode }

export interface LocalDraftOptions {
  mode: 'local';
  companyId: string | null;
  userId: string | null;
  /** This render's form, lines and mode. */
  snapshot: LocalDraftData;
  paused: boolean;
  /** Puts a kept draft back on the form, all three together. */
  onRestore: (draft: LocalDraftData) => void;
}

export interface LocalDraft {
  state: AutosaveState | null;
  savedAt: number | null;
  error: string | null;
  /** A draft kept from an earlier visit, not yet restored or discarded. */
  offer: { savedAt: number } | null;
  restore: () => void;
  discard: () => void;
  /** The invoice was created: forget the draft, and start again from the form as it is next. */
  clear: () => void;
  unsaved: () => boolean;
  /** The form as it would be kept, at the moment of asking. */
  current: () => string | null;
}

const MODES: readonly string[] = ['exclusive', 'inclusive', 'none'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isLocalDraftData = (v: unknown): v is LocalDraftData =>
  isRecord(v) && isRecord(v.form) && Array.isArray(v.lines) && v.lines.every(isRecord) && typeof v.taxMode === 'string' && MODES.includes(v.taxMode);

/** The signed-in user and the active company, or nulls outside their providers. */
export function useInvoiceDraftOwner(): { companyId: string | null; userId: string | null } {
  const auth = useContext(AuthContext);
  const company = useContext(CompanyContext);
  return { companyId: company?.activeCompany?.id ?? null, userId: auth?.user?.id ?? null };
}

const FAILED = 'Could not keep this draft on this device';
const CLEARED_ELSEWHERE = 'This draft is no longer kept: signed out or company switched in another tab';

export function useLocalInvoiceDraft(opts: LocalDraftOptions | null): LocalDraft {
  const key = opts?.companyId && opts.userId ? invoiceDraftKey(opts.companyId, opts.userId) : null;
  const json = opts ? JSON.stringify(opts.snapshot) : null;
  const latest = useRef<{ json: string | null; data: LocalDraftData | null }>({ json: null, data: null });
  const baseline = useRef<string | null>(null);
  const written = useRef<string | null>(null);
  const rebase = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const since = useRef(invoiceDraftGeneration());
  const [clearedElsewhere, setClearedElsewhere] = useState(false);
  const [offer, setOffer] = useState<StoredDraft<LocalDraftData> | null>(null);
  const [writtenJson, setWrittenJson] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useCommitEffect(() => { latest.current = { json, data: opts?.snapshot ?? null }; });
  useEffect(() => {
    if (!rebase.current || json === null) return;
    rebase.current = false;
    baseline.current = json;
    written.current = json;
    setWrittenJson(json);
  }, [json]);

  useEffect(() => { setOffer(key ? readInvoiceDraft(key, isLocalDraftData) : null); }, [key]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === INVOICE_DRAFT_GENERATION_KEY && invoiceDraftsClearedSince(since.current) === 'elsewhere') setClearedElsewhere(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const armed = Boolean(key && !offer && !opts?.paused);
  const writer = useRef({ key, armed });
  useCommitEffect(() => { writer.current = { key, armed }; });
  /** Keeps the form now. Never past a clear; back to how the page opened, there is nothing to keep. */
  const writeNow = useCallback(() => {
    const now = latest.current;
    const { key: k } = writer.current;
    if (!k || now.json === null || now.data === null) return;
    const cleared = invoiceDraftsClearedSince(since.current);
    if (cleared !== 'none') { if (cleared === 'elsewhere') setClearedElsewhere(true); return; }
    const kept = now.json === baseline.current ? removeInvoiceDraft(k) : writeInvoiceDraft(k, { data: now.data, savedAt: Date.now() }, since.current);
    setFailed(!kept);
    if (!kept) return;
    written.current = now.json;
    setWrittenJson(now.json);
    setSavedAt(now.json === baseline.current ? null : Date.now());
  }, []);
  // Declared before the timer's effect, so on unmount it runs first and still sees a write waiting.
  useEffect(() => () => {
    if (timer.current && writer.current.armed) writeNow();
  }, [writeNow]);
  useEffect(() => {
    if (!armed || !key || json === written.current) return undefined;
    timer.current = setTimeout(() => { timer.current = null; writeNow(); }, LOCAL_DEBOUNCE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [armed, json, key, writeNow]);

  const onRestore = opts?.onRestore;
  const restore = useCallback(() => {
    if (offer && onRestore) onRestore(offer.data);
    setOffer(null);
  }, [offer, onRestore]);
  const discard = useCallback(() => {
    if (key) removeInvoiceDraft(key);
    setOffer(null);
  }, [key]);
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!offer && key) removeInvoiceDraft(key); // an unanswered kept draft is not this invoice: it stays, still offered
    written.current = latest.current.json; // nothing unsaved now; the next render's form is the new start
    rebase.current = true;
    setSavedAt(null);
    setFailed(false);
  }, [key, offer]);
  const unsaved = useCallback(() => {
    if (!key) return false;
    const cleared = invoiceDraftsClearedSince(since.current);
    // Cleared here: this tab is signing out or switching, and leaving is the point. Elsewhere: the screen is the only copy.
    return cleared === 'elsewhere' || (cleared === 'none' && latest.current.json !== written.current);
  }, [key]);
  const current = useCallback(() => latest.current.json, []);

  const state: AutosaveState | null = !key ? null
    : failed || clearedElsewhere ? 'error'
      : writtenJson !== null && json !== writtenJson ? 'dirty'
        : savedAt !== null ? 'saved' : null;
  return { state, savedAt, error: clearedElsewhere ? CLEARED_ELSEWHERE : failed ? FAILED : null, offer: offer ? { savedAt: offer.savedAt } : null, restore, discard, clear, unsaved, current };
}
