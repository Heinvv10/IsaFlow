/**
 * Client-side upload + offline-queue helpers for the PWA capture page.
 * Extracted from pages/accounting/capture/index.tsx (300-line rule).
 *
 * Uses apiFetch, which injects X-Company-Id + X-CSRF-Token and leaves
 * Content-Type unset for FormData bodies (browser sets the multipart boundary).
 */

import { apiFetch } from '@/lib/apiFetch';

export const QUEUE_STORAGE_KEY = 'isaflow_capture_queue';

export interface QueuedItem {
  id: string;
  files: { name: string; type: string; dataUrl: string }[];
  queuedAt: string;
}

export interface UploadResult {
  eventIds: string[];
  documentIds: string[];
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
  const res = await apiFetch('/api/accounting/capture/upload', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({})) as {
      error?: { message?: string };
      message?: string;
    };
    throw new Error(json.error?.message ?? json.message ?? 'Upload failed');
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
