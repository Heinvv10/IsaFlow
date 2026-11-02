/**
 * A new invoice's unsaved form, kept in this browser until the invoice is created (master plan wave 3, PR S; spec
 * decision 1: no server draft, so no wallet charge and no burnt invoice number). One key per company and user:
 * `isaflow:invoice-draft:<companyId>:<userId>`. It holds form data only, never a token.
 *
 * Every call is best-effort: storage throws in private mode, over quota, or when the browser blocks it, and a draft
 * that cannot be kept must never break the form. Each function says whether it worked.
 */

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

/** False when the browser refused the write. */
export function writeInvoiceDraft<T>(key: string, draft: StoredDraft<T>): boolean {
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
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(INVOICE_DRAFT_PREFIX)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}
