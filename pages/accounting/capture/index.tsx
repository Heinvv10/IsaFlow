/**
 * PWA Camera Capture page — PRD-05 Phase 1
 * Mobile-first document capture: camera or file picker → upload → inbox.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Camera, Upload, X, FileText, Wifi, WifiOff, Loader2, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';

const QUEUE_STORAGE_KEY = 'isaflow_capture_queue';
const COMPANY_STORAGE_KEY = 'isaflow_active_company';

interface QueuedItem {
  id: string;
  files: { name: string; type: string; dataUrl: string }[];
  queuedAt: string;
}

interface PreviewFile {
  name: string;
  type: string;
  objectUrl: string | null;
  file: File;
}

function readCompanyId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(COMPANY_STORAGE_KEY);
    if (!stored) return null;
    const { id } = JSON.parse(stored);
    return id ?? null;
  } catch { return null; }
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find(c => c.startsWith('isaflow_csrf='));
  return match ? match.slice('isaflow_csrf='.length) : null;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(files: File[]): Promise<{ eventIds: string[] }> {
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
  return (json.data as { eventIds: string[] }) ?? { eventIds: [] };
}

async function flushQueue(): Promise<void> {
  const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
  if (!raw) return;
  const queue: QueuedItem[] = JSON.parse(raw);
  if (queue.length === 0) return;

  const remaining: QueuedItem[] = [];
  for (const item of queue) {
    try {
      const files = await Promise.all(
        item.files.map(async f => {
          const res = await fetch(f.dataUrl);
          const blob = await res.blob();
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

export default function CapturePage() {
  const router = useRouter();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<PreviewFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [online, setOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);

  useEffect(() => {
    setOnline(navigator.onLine);
    const rawQueue = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (rawQueue) {
      try { setQueueCount((JSON.parse(rawQueue) as QueuedItem[]).length); } catch { /* ignore */ }
    }
    const onOnline = () => { setOnline(true); flushQueue().then(() => { const r = localStorage.getItem(QUEUE_STORAGE_KEY); setQueueCount(r ? (JSON.parse(r) as QueuedItem[]).length : 0); }); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
  }, []);

  const addFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    const newPreviews: PreviewFile[] = Array.from(fileList).map(file => ({
      name: file.name,
      type: file.type,
      objectUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      file,
    }));
    setPreviews(prev => [...prev, ...newPreviews]);
  }, []);

  const removePreview = useCallback((idx: number) => {
    setPreviews(prev => {
      const updated = [...prev];
      const removed = updated.splice(idx, 1)[0];
      if (removed?.objectUrl) URL.revokeObjectURL(removed.objectUrl);
      return updated;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (previews.length === 0) return;
    setUploading(true);
    try {
      if (!online) {
        const serialised = await Promise.all(
          previews.map(async p => ({ name: p.name, type: p.type, dataUrl: await fileToDataUrl(p.file) }))
        );
        const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
        const queue: QueuedItem[] = raw ? JSON.parse(raw) : [];
        queue.push({ id: crypto.randomUUID(), files: serialised, queuedAt: new Date().toISOString() });
        localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
        setQueueCount(queue.length);
        toast.success(`Queued — ${queue.length} pending (offline)`);
        setPreviews([]);
      } else {
        await uploadFiles(previews.map(p => p.file));
        toast.success('Documents uploaded successfully');
        previews.forEach(p => { if (p.objectUrl) URL.revokeObjectURL(p.objectUrl); });
        setPreviews([]);
        router.push('/accounting/capture/inbox');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [previews, online, router]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between max-w-lg mx-auto">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10"><Camera className="h-6 w-6 text-indigo-400" /></div>
              <h1 className="text-xl font-bold text-[var(--ff-text-primary)]">Capture</h1>
            </div>
            <div className="flex items-center gap-2 text-xs">
              {online ? (
                <span className="flex items-center gap-1 text-teal-400"><Wifi className="h-3.5 w-3.5" />Online</span>
              ) : (
                <span className="flex items-center gap-1 text-amber-400"><WifiOff className="h-3.5 w-3.5" />Offline</span>
              )}
              {queueCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-medium">
                  {queueCount} queued
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 max-w-lg mx-auto space-y-6">
          {/* Camera CTA */}
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="w-full flex flex-col items-center justify-center gap-3 py-12 rounded-2xl border-2 border-dashed border-indigo-500/40 bg-indigo-500/5 hover:bg-indigo-500/10 active:bg-indigo-500/15 transition-colors cursor-pointer"
          >
            <div className="p-4 rounded-full bg-indigo-500/15">
              <Camera className="h-10 w-10 text-indigo-400" />
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-[var(--ff-text-primary)]">Take Photo</p>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-0.5">Use camera to capture documents</p>
            </div>
          </button>
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={e => addFiles(e.target.files)} />

          {/* File picker */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-3 py-4 rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors text-[var(--ff-text-secondary)] text-sm font-medium"
          >
            <Upload className="h-5 w-5" />
            Choose from device (PDF, JPG, PNG)
          </button>
          <input ref={fileInputRef} type="file" accept="image/*,.pdf,application/pdf" multiple className="hidden" onChange={e => addFiles(e.target.files)} />

          {/* Previews */}
          {previews.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[var(--ff-text-primary)]">{previews.length} file{previews.length !== 1 ? 's' : ''} selected</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {previews.map((p, idx) => (
                  <div key={idx} className="relative rounded-lg overflow-hidden border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] aspect-square flex items-center justify-center">
                    {p.objectUrl ? (
                      <img src={p.objectUrl} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="flex flex-col items-center gap-2 p-3">
                        <FileText className="h-8 w-8 text-[var(--ff-text-tertiary)]" />
                        <span className="text-xs text-[var(--ff-text-secondary)] text-center break-all line-clamp-2">{p.name}</span>
                      </div>
                    )}
                    <button
                      onClick={() => removePreview(idx)}
                      className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white hover:bg-black/80"
                      aria-label={`Remove ${p.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={uploading}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-base disabled:opacity-60 transition-colors"
              >
                {uploading ? (
                  <><Loader2 className="h-5 w-5 animate-spin" />Uploading...</>
                ) : online ? (
                  <><CheckCircle2 className="h-5 w-5" />Upload {previews.length} document{previews.length !== 1 ? 's' : ''}</>
                ) : (
                  <><WifiOff className="h-5 w-5" />Queue for upload (offline)</>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
