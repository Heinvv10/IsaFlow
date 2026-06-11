/**
 * Client-side upload + offline-queue helpers for the PWA capture page.
 * Extracted from pages/accounting/capture/index.tsx (300-line rule).
 */

export const QUEUE_STORAGE_KEY = 'isaflow_capture_queue';
const COMPANY_STORAGE_KEY = 'isaflow_active_company';

export interface QueuedItem {
  id: string;
  files: { name: string; type: string; dataUrl: string }[];
  queuedAt: string;
}

export interface UploadResult {
  eventIds: string[];
  documentIds: string[];
}

function readCompanyId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(COMPANY_STORAGE_KEY);
    if (!stored) return null;
    const { id } = JSON.parse(stored) as { id?: string };
    return id ?? null;
  } catch { return null; }
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find(c => c.startsWith('isaflow_csrf='));
  return match ? match.slice('isaflow_csrf='.length) : null;
}

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function uploadFiles(files: File[]): Promise<UploadResult> {
  const form = new FormData();
  files.forEach(f => form.append('files[]', f));
  const headers = new Headers();
  const companyId = readCompanyId();
  if (companyId) headers.set('X-Company-Id', companyId);
  const csrf = readCsrfCookie();
  if (csrf) headers.set('X-CSRF-Token', csrf);
  const res = await fetch('/api/accounting/capture/upload', {
    method: 'POST',
    body: form,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as { message?: string }).message ?? 'Upload failed');
  }
  const json = await res.json();
  const data = (json.data as Partial<UploadResult>) ?? {};
  return { eventIds: data.eventIds ?? [], documentIds: data.documentIds ?? [] };
}

export async function flushQueue(): Promise<void> {
  const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
  if (!raw) return;
  const queue: QueuedItem[] = JSON.parse(raw) as QueuedItem[];
  if (queue.length === 0) return;

  const remaining: QueuedItem[] = [];
  for (const item of queue) {
    try {
      const files = await Promise.all(
        item.files.map(async f => {
          const r = await fetch(f.dataUrl);
          const blob = await r.blob();
          return new File([blob], f.name, { type: f.type });
        })
      );
      await uploadFiles(files);
    } catch {
      remaining.push(item);
    }
  }
  localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(remaining));
}
