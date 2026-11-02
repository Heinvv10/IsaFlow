/**
 * A new invoice's form, kept in this browser until it is created (master plan wave 3, PR S; spec decision 1: no server
 * draft, so no wallet charge and no burnt invoice number). 800 ms after the last change the form, lines and VAT mode,
 * taken together from one render, go to localStorage under the company and user (src/lib/invoiceDrafts.ts).
 *
 * - Nothing is written until the form differs from how the page opened, and nothing without a company and a user.
 * - A kept draft is offered on the next visit; nothing overwrites it until the user restores or discards it.
 * - Never while `paused` (a VAT rate edit under way), as on the edit page.
 * - A storage that throws is shown, never raised; the next change tries again.
 * - `clear` after a successful create; sign-out and a company switch clear every draft (AuthContext, CompanyContext).
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AuthContext } from '@/contexts/AuthContext';
import { CompanyContext } from '@/contexts/CompanyContext';
import type { AutosaveState } from '@/components/ui/AutosaveStatus';
import { invoiceDraftKey, readInvoiceDraft, removeInvoiceDraft, writeInvoiceDraft, type StoredDraft } from '@/lib/invoiceDrafts';
import type { InvoiceHeaderForm } from './invoiceHeaderForm';
import type { InvoiceLine } from './InvoiceLineItemsTable';
import type { TaxMode } from './taxMode';

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

export function useLocalInvoiceDraft(opts: LocalDraftOptions | null): LocalDraft {
  const key = opts?.companyId && opts.userId ? invoiceDraftKey(opts.companyId, opts.userId) : null;
  const json = opts ? JSON.stringify(opts.snapshot) : null;
  const latest = useRef<{ json: string | null; data: LocalDraftData | null }>({ json: null, data: null });
  const baseline = useRef<string | null>(null);
  const written = useRef<string | null>(null);
  const rebase = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [offer, setOffer] = useState<StoredDraft<LocalDraftData> | null>(null);
  const [writtenJson, setWrittenJson] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => { latest.current = { json, data: opts?.snapshot ?? null }; });
  useEffect(() => {
    if (!rebase.current || json === null) return;
    rebase.current = false;
    baseline.current = json;
    written.current = json;
    setWrittenJson(json);
  }, [json]);

  useEffect(() => { setOffer(key ? readInvoiceDraft(key, isLocalDraftData) : null); }, [key]);

  const armed = Boolean(key && !offer && !opts?.paused);
  useEffect(() => {
    if (!armed || !key || json === written.current) return undefined;
    timer.current = setTimeout(() => {
      timer.current = null;
      const now = latest.current;
      if (now.json === null || now.data === null) return;
      // Back to how the page opened: there is nothing to keep.
      const kept = now.json === baseline.current ? removeInvoiceDraft(key) : writeInvoiceDraft(key, { data: now.data, savedAt: Date.now() });
      setFailed(!kept);
      if (!kept) return;
      written.current = now.json;
      setWrittenJson(now.json);
      setSavedAt(now.json === baseline.current ? null : Date.now());
    }, LOCAL_DEBOUNCE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [armed, json, key]);

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
    if (key) removeInvoiceDraft(key);
    written.current = latest.current.json; // nothing unsaved now; the next render's form is the new start
    rebase.current = true;
    setSavedAt(null);
    setFailed(false);
  }, [key]);
  const unsaved = useCallback(() => Boolean(key) && latest.current.json !== written.current, [key]);

  const state: AutosaveState | null = !key ? null
    : failed ? 'error'
      : writtenJson !== null && json !== writtenJson ? 'dirty'
        : savedAt !== null ? 'saved' : null;
  return { state, savedAt, error: failed ? FAILED : null, offer: offer ? { savedAt: offer.savedAt } : null, restore, discard, clear, unsaved };
}
