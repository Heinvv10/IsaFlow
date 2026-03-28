/**
 * ScanAndFillButton — Upload a document to extract data via VLM
 * Reusable component for invoice/payment creation pages.
 * Only renders when VLM is available.
 */

import { useState, useEffect, useRef } from 'react';
import { ScanLine, Loader2, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

interface ScanAndFillButtonProps {
  onExtracted: (data: ExtractedDocument) => void;
  className?: string;
  label?: string;
}

export function ScanAndFillButton({ onExtracted, className = '', label = 'Scan & Fill' }: ScanAndFillButtonProps) {
  const [vlmAvailable, setVlmAvailable] = useState<boolean | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [lastResult, setLastResult] = useState<{ confidence: number; warnings: string[] } | null>(null);
  const [showWarnings, setShowWarnings] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    apiFetch('/api/accounting/vlm-status')
      .then(r => r.json())
      .then(json => setVlmAvailable(json.data?.available ?? false))
      .catch(() => setVlmAvailable(false));
  }, []);

  if (vlmAvailable === null || vlmAvailable === false) return null;

  async function handleFile(file: File) {
    const allowedExts = ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tiff', '.tif'];
    const ext = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    if (!allowedExts.includes(ext)) {
      notify.error('Supported formats: PDF, JPEG, PNG, WebP, TIFF');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      notify.error('File too large. Maximum 10MB.');
      return;
    }

    setIsExtracting(true);
    setLastResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await apiFetch('/api/accounting/vlm-extract', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || 'Extraction failed');

      const extracted = json.data.extracted as ExtractedDocument;
      setLastResult({
        confidence: extracted.confidence,
        warnings: extracted.warnings,
      });

      onExtracted(extracted);

      if (extracted.confidence >= 0.7) {
        notify.success(`Document scanned (${Math.round(extracted.confidence * 100)}% confidence)`);
      } else if (extracted.confidence >= 0.4) {
        notify.success('Document scanned — some fields may need review');
      } else {
        notify.error('Low confidence extraction — please review all fields');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Extraction failed';
      notify.error(msg);
    } finally {
      setIsExtracting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const confidenceColor = lastResult
    ? lastResult.confidence >= 0.7 ? 'text-teal-400' : lastResult.confidence >= 0.4 ? 'text-amber-400' : 'text-red-400'
    : '';

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,application/pdf,image/jpeg,image/png,image/webp,image/tiff"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />

      <button
        type="button"
        disabled={isExtracting}
        onClick={() => fileRef.current?.click()}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-teal-500/30 bg-teal-500/10 text-teal-400 hover:bg-teal-500/20 transition-colors disabled:opacity-50"
      >
        {isExtracting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ScanLine className="h-4 w-4" />
        )}
        {isExtracting ? 'Extracting...' : label}
      </button>

      {lastResult && (
        <span className={`inline-flex items-center gap-1 text-xs font-medium ${confidenceColor}`}>
          {lastResult.confidence >= 0.7 ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5" />
          )}
          {Math.round(lastResult.confidence * 100)}%
          {lastResult.warnings.length > 0 && (
            <button
              type="button"
              onClick={() => setShowWarnings(!showWarnings)}
              className="underline ml-1"
            >
              {lastResult.warnings.length} warning{lastResult.warnings.length !== 1 ? 's' : ''}
            </button>
          )}
        </span>
      )}

      {showWarnings && lastResult && lastResult.warnings.length > 0 && (
        <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-3 shadow-xl max-w-md">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-amber-400">Extraction Warnings</span>
            <button type="button" onClick={() => setShowWarnings(false)}>
              <X className="h-3.5 w-3.5 text-[var(--ff-text-tertiary)]" />
            </button>
          </div>
          <ul className="space-y-1">
            {lastResult.warnings.map((w, i) => (
              <li key={i} className="text-xs text-[var(--ff-text-secondary)]">{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
