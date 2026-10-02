// ── Types ─────────────────────────────────────────────────────────────────────

export interface Attachment {
  id: string;
  bank_transaction_id: string;
  file_url: string;
  file_name: string;
  file_size: number | null;
  uploaded_by: string | null;
  created_at: string;
}

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
