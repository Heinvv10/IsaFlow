/**
 * The polite live region for undoable toasts, mounted once in _app. A screen reader reads a live region's CHANGES, and
 * a region that arrives with its text in it is no change: a toast cannot be its own. The keyed span makes the same
 * sentence twice in a row a change too.
 */

import { useEffect, useState } from 'react';

let listener: ((text: string) => void) | null = null;

export function announceUndo(text: string): void {
  listener?.(text);
}

export function UndoAnnouncer() {
  const [said, setSaid] = useState({ n: 0, text: '' });
  useEffect(() => {
    listener = (text) => setSaid((prev) => ({ n: prev.n + 1, text }));
    return () => { listener = null; };
  }, []);
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {said.text && <span key={said.n}>{said.text}</span>}
    </div>
  );
}
