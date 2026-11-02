/**
 * A new invoice's unsaved form, kept in this browser until the invoice is created (master plan wave 3, PR S; spec
 * decision 1: no server draft, so no wallet charge and no burnt invoice number). One key per company and user:
 * `isaflow:invoice-draft:<companyId>:<userId>`. It holds form data only, never a token.
 *
 * Every call is best-effort: storage throws in private mode, over quota, or when the browser blocks it, and a draft
 * that cannot be kept must never break the form. Each function says whether it worked.
 *
 * A clear (sign-out, an expired session, a company switch) starts a new generation. A writer holds the generation it
 * began in and can never write past a clear: a draft timer still pending on the page being left cannot put the draft
 * back. A page opened after the clear (the next sign-in, in the same tab) begins in the new one and writes as normal.
 * The generation lives in localStorage, so a clear in one tab stops the writers in every other tab of this browser
 * too; the in-memory count covers a storage that cannot be read.
 */
import { log } from '@/lib/logger';

const GENERATION_KEY = 'isaflow:invoice-drafts-generation'; // not under INVOICE_DRAFT_PREFIX: a clear must not remove it
let localGeneration = 0;

function storedGeneration(): number {
  try {
    const n = Number(window.localStorage.getItem(GENERATION_KEY) ?? '0');
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // unreadable storage: the in-memory count still holds in this tab
  }
}

/** The generation a draft writer begins in; pass it to every write. */
export const invoiceDraftGeneration = (): string => `${storedGeneration()}:${localGeneration}`;

/** The key other tabs' clears are announced under (a `storage` event). */
export const INVOICE_DRAFT_GENERATION_KEY = GENERATION_KEY;

/**
 * Whether drafts were cleared since `since`: 'here' (this tab: its own sign-out or switch, which is leaving anyway),
 * 'elsewhere' (another tab of this browser), or 'none'.
 */
export function invoiceDraftsClearedSince(since: string): 'none' | 'here' | 'elsewhere' {
  const [stored, local] = since.split(':').map(Number);
  if (local !== localGeneration) return 'here';
  return stored !== storedGeneration() ? 'elsewhere' : 'none';
}

export const INVOICE_DRAFT_PREFIX = 'isaflow:invoice-draft:';

export const invoiceDraftKey = (companyId: string, userId: string): string =>
  `${INVOICE_DRAFT_PREFIX}${companyId}:${userId}`;

export interface StoredDraft<T> { data: T; savedAt: number }

/** The draft under `key`, or null when there is none, it cannot be read, or it is not one this code wrote. */
export function readInvoiceDraft<T>(key: string, isData: (v: unknown) => v is T): StoredDraft<T> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { data?: unknown; savedAt?: unknown };
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.savedAt !== 'number' || !isData(parsed.data)) return null;
    return { data: parsed.data, savedAt: parsed.savedAt };
  } catch {
    return null; // unreadable storage or a corrupt value: there is no draft to offer
  }
}

/** False when the browser refused the write, or a clear came after `since` (invoiceDraftGeneration). */
export function writeInvoiceDraft<T>(key: string, draft: StoredDraft<T>, since: string): boolean {
  if (since !== invoiceDraftGeneration()) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function removeInvoiceDraft(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Every invoice draft on this device, whoever's: on sign-out and on a company switch. */
export function clearInvoiceDrafts(): boolean {
  if (typeof window === 'undefined') return true;
  localGeneration++;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(INVOICE_DRAFT_PREFIX)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
    window.localStorage.setItem(GENERATION_KEY, String(storedGeneration() + 1)); // every other tab's writers stop too
    return true;
  } catch (err) {
    log.warn('Could not clear the invoice drafts from this browser', { err }, 'invoiceDrafts');
    return false;
  }
}
