/**
 * The IsaFlow Sage Connector browser extension, seen from the admin Sage
 * auto-import page (pages/admin/tools/sage-import.tsx): whether it is installed
 * and a request/reply channel over window.postMessage. Moved out of the page
 * unchanged.
 */

import { useState, useCallback, useEffect, useRef } from 'react';

export interface ExtensionReply {
  ok: boolean;
  error?: string | null;
  value?: string;
  names?: string[];
  count?: number;
  version?: string;
}

export function useSageExtension() {
  const [installed, setInstalled] = useState(false);
  const [version, setVersion] = useState('');
  const pendingRef = useRef<Map<string, (r: ExtensionReply) => void>>(new Map());

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const d = ev.data;
      if (!d || typeof d !== 'object' || d.source !== 'isaflow-sage-extension') return;
      if (d.type === 'announce') {
        setInstalled(true);
        if (d.version) setVersion(d.version);
        return;
      }
      if (typeof d.requestId === 'string' && d.type?.endsWith?.('-reply')) {
        const cb = pendingRef.current.get(d.requestId);
        if (cb) {
          pendingRef.current.delete(d.requestId);
          cb(d as ExtensionReply);
        }
      }
    }
    window.addEventListener('message', onMessage);
    // Active probe in case the extension's announce fired before this hook mounted.
    window.postMessage({ source: 'isaflow-sage-page', type: 'isaflow-sage-ext-ping', requestId: 'probe-' + Date.now() }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const ask = useCallback((type: string, timeoutMs = 4000): Promise<ExtensionReply> => {
    return new Promise((resolve) => {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        if (pendingRef.current.delete(requestId)) {
          resolve({ ok: false, error: 'Extension did not respond' });
        }
      }, timeoutMs);
      pendingRef.current.set(requestId, (r) => { clearTimeout(timer); resolve(r); });
      window.postMessage({ source: 'isaflow-sage-page', type, requestId }, '*');
    });
  }, []);

  return { installed, version, ask };
}
