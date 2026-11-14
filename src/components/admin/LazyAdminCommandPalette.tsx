/**
 * The admin host's Ctrl+K, loaded as its own chunk so the tenant app's bundle never carries it.
 *
 * - Preload: the chunk is fetched when the browser is idle after mount (or at once when Ctrl+K comes first).
 * - Until it arrives an open palette is a shell with the search box focused; what is typed there becomes the real
 *   palette's starting query, so no keystroke is lost.
 * - If the chunk fails to load, the shell says so (and the failure is logged) instead of the palette never appearing;
 *   the next open tries again.
 *
 * Not next/dynamic: its `loading` slot takes no props, so the text typed into it could not reach the palette.
 */
import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Search } from 'lucide-react';
import { log } from '@/lib/logger';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import type { AdminCommandPaletteProps } from './AdminCommandPalette';

type Palette = ComponentType<AdminCommandPaletteProps>;

export const SEARCH_UNAVAILABLE = 'Search unavailable, reload the page';

const loadPalette = (): Promise<Palette> => import('./AdminCommandPalette').then(m => m.AdminCommandPalette);

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void };

function PaletteShell({ value, onChange, onClose, failed }: { value: string; onChange: (v: string) => void; onClose: () => void; failed: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onClose);
  // Failed, the search box is disabled and the dialog has nothing focusable: hold focus on the dialog itself, so it
  // does not stay on the page behind it.
  useEffect(() => { if (failed) dialogRef.current?.focus(); }, [failed]);
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
        className="w-full max-w-xl mx-4 bg-surface border border-line rounded-xl shadow-2xl flex flex-col overflow-hidden outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 border-b border-line">
          <Search className="w-5 h-5 text-ink-muted flex-shrink-0" aria-hidden="true" />
          <input
            type="text"
            aria-label="Search admin pages, companies and users"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={failed}
            placeholder="Search pages, companies, users..."
            className="flex-1 py-4 text-base bg-transparent outline-none text-ink placeholder:text-ink-muted"
          />
        </div>
        {failed
          ? <p role="alert" className="px-4 py-3 text-sm text-ink">{SEARCH_UNAVAILABLE}</p>
          : <p role="status" className="px-4 py-3 text-sm text-ink-muted">Loading…</p>}
      </div>
    </div>
  );
}

export function LazyAdminCommandPalette({ isOpen, onClose }: AdminCommandPaletteProps) {
  const [Loaded, setLoaded] = useState<Palette | null>(null);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState('');
  /** A load is in flight or done. Cleared when one fails, so the next open retries. */
  const started = useRef(false);
  /** Any load was ever attempted: the idle preload is a one-off, and must not become a retry loop after a failure. */
  const tried = useRef(false);
  const mounted = useRef(true);

  const start = useCallback(() => {
    if (started.current) return;
    started.current = true;
    tried.current = true;
    loadPalette()
      .then((P) => { if (mounted.current) setLoaded(() => P); })
      .catch((err: unknown) => {
        log.warn('Could not load the admin command palette', { error: err }, 'admin-ui');
        // Not sticky: the next open tries again (webpack re-requests a chunk whose load failed).
        started.current = false;
        if (mounted.current) setFailed(true);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const preload = () => { if (!tried.current) start(); };
    const w = window as IdleWindow;
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(preload);
      return () => { mounted.current = false; w.cancelIdleCallback?.(id); };
    }
    const t = setTimeout(preload, 0);
    return () => { mounted.current = false; clearTimeout(t); };
  }, [start]);

  useEffect(() => { if (isOpen) start(); }, [isOpen, start]);

  // Each open starts empty, as the real palette does. A failure is cleared on close too: the shell unmounts while
  // closed, so the next open mounts it fresh with an enabled search box, which its focus trap focuses, while it retries.
  if (!isOpen && typed) setTyped('');
  if (!isOpen && failed) setFailed(false);

  if (Loaded) return <Loaded isOpen={isOpen} onClose={onClose} initialQuery={typed} />;
  if (!isOpen) return null;
  return <PaletteShell value={typed} onChange={setTyped} onClose={onClose} failed={failed} />;
}
