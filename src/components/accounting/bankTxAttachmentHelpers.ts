// ── Types ─────────────────────────────────────────────────────────────────────

export interface Attachment {
  id: string;
  bank_transaction_id: string;
  file_url: string;
  file_name: string;
  file_size: number | null;
  uploaded_by: string | null;
  created_at: string;
  /** A captured document linked to the line (copied or not). Remove unlinks it rather than deleting a copy. */
  document_id?: string;
  /**
   * 'captured': a linked captured document. With no copy its file_url is the route that serves its bytes.
   * 'settled_document': a document of a bill / invoice the line settles (include_settled=1); read-only, never removed.
   */
  source?: 'captured' | 'settled_document';
  /** settled_document only: the payment the line went through. */
  via?: { kind: 'supplier_payment' | 'customer_payment'; payment_id: string; payment_number: string | null };
  /** settled_document only: what the document belongs to and what this payment applied to it. */
  settles?: {
    entity_type: 'supplier_invoice' | 'customer_invoice' | 'credit_note';
    entity_id: string; number: string | null; total: number; applied: number;
    /** Still open after every live payment and credit note; outstanding is that amount (null for a credit note). */
    partial: boolean; outstanding: number | null;
    invoice_id: string; invoice_number: string | null;
  };
  /** The type a captured document claims. Decides View and the download extension; the viewer trusts only its bytes. */
  content_type?: string | null;
}

export const isSettled = (a: Attachment): boolean => a.source === 'settled_document';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const ACCEPT = '.jpg,.jpeg,.png,.pdf';
export const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'application/pdf'];

// Stored attachments are server-mirrored data-URLs (whitelisted MIME at write
// time) or https links. Refuse to hyperlink anything else — a corrupt or
// directly-inserted data:text/html row must never become a clickable XSS.
// SECURITY-CRITICAL allowlist: this is the single render sink for stored attachment
// data URLs and is the last line of defence against a magic-byte polyglot (a valid
// image/PDF header with appended markup). Do NOT widen it to gif/svg/html/* — the
// upload magic-byte validation (src/lib/fileMagic.ts) assumes inert MIMEs render here.
// attachmentPreview.canDownload adds one case beside this: data:application/octet-stream, which a browser saves and
// never renders, under a name safeDownloadName gives a neutral extension. Do not treat that as room to widen this.
export const SAFE_HREF = /^(https:\/\/|data:(image\/(jpeg|png|webp|tiff)|application\/pdf);base64,)/;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIcon(name: string): 'image' | 'pdf' | 'generic' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'generic';
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/** The line's true number of documents from a list response: X-Attachments-Total, else the list's own length. */
export function attachmentTotal(res: { headers: { get(name: string): string | null } }, listLength: number): number {
  const n = Number(res.headers.get('X-Attachments-Total'));
  return Number.isInteger(n) && n >= listLength ? n : listLength;
}
