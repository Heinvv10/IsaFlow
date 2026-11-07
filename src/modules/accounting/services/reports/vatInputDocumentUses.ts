/**
 * One tax invoice backs one claim's worth of VAT (Hein, 2026-11-07): the verdicts on a chain's documents that sit on
 * its bank lines or its expense claim lines (vatInputSupportQuery: bank_documents, claim_documents).
 *
 * Every use of a captured document adds to its claimed total — a journal tie, the journal on a bank line it sits on,
 * a bill, an expense claim line (that line's VAT) — over every period to the period end. `total` is that sum; `own`
 * is this chain's share of it, so `total - own` is what OTHER claims already take from the document.
 */

/** The report's cent tolerance (vatInputSupport uses this one). */
export const CENT = 0.005;

export interface DocumentUse {
  /** The document's VAT; null when none was read (presence only: it backs no figure). */
  vat: number | 'unreadable' | null;
  total: number;
  own: number;
  /** How many of this chain's expense claim lines carry the document (0 for a bank-line use). */
  lines: number;
}

export type BankDocumentsVerdict =
  | { kind: 'supported' }
  | { kind: 'over_claimed' | 'mismatch'; documentVat: number; documentClaimedVat: number }
  | { kind: 'unreadable' };

/** A document with positive VAT read. A credit note (negative VAT) or a nil-VAT document backs no claim. */
const readable = (u: DocumentUse): u is DocumentUse & { vat: number } => typeof u.vat === 'number' && u.vat > CENT;
const others = (u: DocumentUse): number => u.total - u.own;

/**
 * The documents on a chain's bank lines, judged as uses. What the chain may claim is each readable document's VAT
 * less what other claims already take from it, summed (an invoice paid in parts, or two invoices on one line).
 * Over that is `over_claimed` when another claim shares a document. Otherwise `mismatch`, unless the line also holds
 * a document the report cannot weigh: an unreadable one makes it a warning, a plain upload (`hasUpload`) leaves it
 * supported as before (the upload may be the full invoice). Null when the line has no document with VAT read:
 * presence decides.
 */
export function judgeBankDocuments(uses: DocumentUse[], claimedToDate: number, hasUpload = false): BankDocumentsVerdict | null {
  const withVat = uses.filter(readable);
  const unreadable = uses.some((u) => u.vat === 'unreadable');
  if (withVat.length === 0) return unreadable ? { kind: 'unreadable' } : null;
  const available = withVat.reduce((s, u) => s + u.vat - others(u), 0);
  if (claimedToDate <= available + CENT) return { kind: 'supported' };
  const documentVat = withVat.reduce((s, u) => s + u.vat, 0);
  const shared = withVat.some((u) => others(u) > CENT);
  if (!shared && unreadable) return { kind: 'unreadable' };
  if (!shared && hasUpload) return { kind: 'supported' };
  return {
    kind: shared ? 'over_claimed' : 'mismatch', documentVat,
    documentClaimedVat: claimedToDate + withVat.reduce((s, u) => s + Math.max(others(u), 0), 0),
  };
}

/**
 * The first document on a chain's expense claim lines that is used more than once — by other claims, or on two or
 * more of this claim's lines — past its VAT, or null. One line's VAT differing from its slip is the claim's own
 * figure, not a second use, and is not this rule's.
 */
export function overClaimedClaimDocument(uses: DocumentUse[]): (DocumentUse & { vat: number }) | null {
  return uses.find((u): u is DocumentUse & { vat: number } =>
    readable(u) && (others(u) > CENT || u.lines > 1) && u.total > u.vat + CENT) ?? null;
}
